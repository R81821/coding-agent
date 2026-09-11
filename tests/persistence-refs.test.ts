import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HarnessDatabase,
  VaultCrypto,
  ensureV2Storage,
} from "@harness/persistence";
import { DEFAULT_PROFILE } from "@harness/protocol";
import type { RunCheckpoint, AgentEvent } from "@harness/protocol";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-ref-"));
  roots.push(root);
  const path = join(root, "harness.sqlite");
  const vault = await VaultCrypto.open(
    join(root, "key-envelope.json"),
    "fixture-password",
  );
  return { root, path, vault };
}
const at = "2026-01-01T00:00:00.000Z";
function checkpoint(id: string, runId = "run", sequence = 1): RunCheckpoint {
  return {
    id,
    runId,
    sequence,
    reason: "manual",
    status: "running",
    transcript: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "shared " + "x".repeat(5000),
            trust: "user_request",
          },
        ],
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    turns: 1,
    toolCalls: 0,
    pendingNonIdempotentToolCalls: [],
    createdAt: at,
  } as RunCheckpoint;
}
it("stores shared transcript once and restores exact checkpoints using run-scoped queries", async () => {
  const { path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  try {
    for (let i = 0; i < 8; i++)
      db.saveCheckpoint(checkpoint("cp" + i, "run" + i));
    const expected = checkpoint("last", "run0", 2);
    db.saveCheckpoint(expected);
    const raw = new DatabaseSync(path);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM content_objects").get()?.n,
      ).toBe(1);
      const row = raw
        .prepare("SELECT payload FROM checkpoints WHERE id='last'")
        .get()!;
      expect(
        vault.decryptJson<Record<string, unknown>>(
          String(row.payload),
          "checkpoints:last",
        ).transcript,
      ).toBeUndefined();
    } finally {
      raw.close();
    }
    const spy = vi.spyOn(vault, "decryptJson");
    expect(db.getLatestCheckpoint("run0")).toEqual(expected);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  } finally {
    db.close();
    vault.dispose();
  }
});
it("buffers text in one transaction and flushes before a boundary, reads and close", async () => {
  const { path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  db.saveRun({
    id: "run",
    sessionId: "s",
    request: "hi",
    workspacePath: "D:/test",
    profileId: "balanced",
    attachments: [],
    budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 },
    grants: [],
    createdAt: at,
  });
  const raw = new DatabaseSync(path);
  try {
    const events = Array.from(
      { length: 3 },
      (_, sequence) =>
        ({
          id: "e" + sequence,
          runId: "run",
          sequence,
          type: "text_delta",
          delta: "hello",
          at,
        }) as AgentEvent,
    );
    events.forEach((e) => db.appendEvent(e));
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
    expect(db.listEvents("run")).toEqual(events);
    db.appendEvent({ ...events[0]!, id: "e3", sequence: 3 } as AgentEvent);
    db.close();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(4);
  } finally {
    raw.close();
    vault.dispose();
  }
});
it("missing schema marker preserves vault and database identity", async () => {
  const { root, path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  db.saveCheckpoint(checkpoint("old"));
  db.close();
  const key = await readFile(join(root, "key-envelope.json"));
  await ensureV2Storage(root);
  expect(await readFile(join(root, "key-envelope.json"))).toEqual(key);
  const reopened = await HarnessDatabase.open(path, vault);
  try {
    expect(reopened.getLatestCheckpoint("run")).toEqual(checkpoint("old"));
  } finally {
    reopened.close();
    vault.dispose();
  }
});

async function legacy(path: string, vault: VaultCrypto, corrupt = false) {
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE checkpoints (id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)",
  );
  raw
    .prepare("INSERT INTO checkpoints VALUES (?,?,?)")
    .run(
      "old",
      corrupt
        ? "invalid-envelope"
        : vault.encryptJson(checkpoint("old"), "checkpoints:old"),
      at,
    );
  raw.close();
}
it("stages legacy conversion, retains a readable original backup and preserves key bytes across restart", async () => {
  const { root, path, vault } = await fixture();
  await legacy(path, vault);
  const key = await readFile(join(root, "key-envelope.json"));
  const db = await HarnessDatabase.open(path, vault);
  expect(db.getLatestCheckpoint("run")).toEqual(checkpoint("old"));
  db.close();
  const backups = (await readdir(root)).filter((name) =>
    name.includes(".pre-v3-"),
  );
  expect(backups).toHaveLength(1);
  const backup = new DatabaseSync(join(root, backups[0]!));
  try {
    const row = backup.prepare("SELECT payload FROM checkpoints").get()!;
    expect(vault.decryptJson(String(row.payload), "checkpoints:old")).toEqual(
      checkpoint("old"),
    );
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
  } finally {
    backup.close();
  }
  expect(await readFile(join(root, "key-envelope.json"))).toEqual(key);
  const reopened = await HarnessDatabase.open(path, vault);
  reopened.saveCheckpoint(checkpoint("new", "run", 2));
  reopened.close();
  expect(
    (await readdir(root)).filter((name) => name.includes(".pre-v3-")),
  ).toEqual(backups);
  vault.dispose();
});
it("failed conversion keeps original bytes and retained backup, and can be retried", async () => {
  const { root, path, vault } = await fixture();
  await legacy(path, vault, true);
  const before = await readFile(path);
  await expect(HarnessDatabase.open(path, vault)).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
  expect(
    (await readdir(root)).filter((name) => name.includes(".pre-v3-")),
  ).toHaveLength(1);
  const raw = new DatabaseSync(path);
  raw
    .prepare("UPDATE checkpoints SET payload=?")
    .run(vault.encryptJson(checkpoint("old"), "checkpoints:old"));
  raw.close();
  const db = await HarnessDatabase.open(path, vault);
  expect(db.getLatestCheckpoint("run")).toEqual(checkpoint("old"));
  db.close();
  vault.dispose();
});
it("flushes delta batches after 100 ms and before tool events, including close after cancellation", async () => {
  const { path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  db.saveRun({
    id: "run",
    sessionId: "s",
    request: "hi",
    workspacePath: "D:/test",
    profileId: "balanced",
    attachments: [],
    budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 },
    grants: [],
    createdAt: at,
  });
  const raw = new DatabaseSync(path);
  vi.useFakeTimers();
  try {
    const delta = {
      id: "e0",
      runId: "run",
      sequence: 0,
      type: "text_delta",
      delta: "hello",
      at,
    } satisfies AgentEvent;
    db.appendEvent(delta);
    vi.advanceTimersByTime(99);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
    vi.advanceTimersByTime(1);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(1);
    db.appendEvent({ ...delta, id: "e1", sequence: 1 });
    db.appendEvent({
      id: "e2",
      runId: "run",
      sequence: 2,
      type: "tool_started",
      call: { id: "call", name: "read_file", input: {} },
      at,
    });
    expect(
      raw
        .prepare("SELECT sequence FROM events ORDER BY sequence")
        .all()
        .map((row) => row.sequence),
    ).toEqual([0, 1, 2]);
    db.appendEvent({
      ...delta,
      id: "e3",
      sequence: 3,
      delta: "x".repeat(4096),
    });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(4);
    db.appendEvent({ ...delta, id: "e4", sequence: 4 });
    db.updateRunStatus("run", "cancelled");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(5);
  } finally {
    vi.useRealTimers();
    db.close();
    raw.close();
    vault.dispose();
  }
});
it("deduplicates repeated tool output ciphertext, preserving case-distinct messages and output AAD", async () => {
  const { path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  db.saveRun({
    id: "run",
    sessionId: "s",
    request: "hi",
    workspacePath: "D:/test",
    profileId: "balanced",
    attachments: [],
    budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 },
    grants: [],
    createdAt: at,
  });
  const events = Array.from({ length: 5 }, (_, sequence) => ({
    id: "e" + sequence,
    runId: "run",
    sequence,
    type: "tool_finished" as const,
    callId: "c" + sequence,
    output: { content: "Sensitive repeated output".repeat(100) },
    durationMs: 1,
    at,
  }));
  try {
    events.forEach((event) => db.appendEvent(event));
    expect(db.listEvents("run")).toEqual(events);
    const lower = checkpoint("lower");
    const upper = {
      ...checkpoint("upper"),
      transcript: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "SHARED " + "X".repeat(5000),
              trust: "user_request" as const,
            },
          ],
        },
      ],
    };
    db.saveCheckpoint(lower);
    db.saveCheckpoint(upper);
    expect(db.listCheckpoints("run")).toContainEqual(upper);
    const raw = new DatabaseSync(path);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM content_objects").get()?.n,
      ).toBe(3);
      const row = raw
        .prepare("SELECT id,payload FROM content_objects LIMIT 1")
        .get()!;
      expect(() =>
        vault.decryptJson(String(row.payload), "content:wrong-id"),
      ).toThrow();
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    vault.dispose();
  }
});

it("retains buffered events after a failed transaction and retries without sequence loss", async () => {
  const { path, vault } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  db.saveRun({
    id: "run",
    sessionId: "s",
    request: "hi",
    workspacePath: "D:/test",
    profileId: "balanced",
    attachments: [],
    budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 },
    grants: [],
    createdAt: at,
  });
  const raw = new DatabaseSync(path);
  try {
    const event = {
      id: "e0",
      runId: "run",
      sequence: 0,
      type: "text_delta" as const,
      delta: "pending",
      at,
    };
    db.appendEvent(event);
    raw.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
    );
    expect(() => db.flushEvents()).toThrow("simulated disk failure");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
    raw.exec("DROP TRIGGER fail_event");
    db.flushEvents();
    expect(db.listEvents("run")).toEqual([event]);
  } finally {
    db.close();
    raw.close();
    vault.dispose();
  }
});

it("permanent deletion reclaims only unshared objects of that session", async () => {
  const { path, vault, root } = await fixture();
  const db = await HarnessDatabase.open(path, vault);
  const raw = new DatabaseSync(path);
  try {
    for (const id of ["removed", "retained"]) {
      db.createSession({ id, workspacePath: root, profileId: "default", title: id, createdAt: at, updatedAt: at });
      db.saveRun({ id, sessionId: id, workspacePath: root, request: id, profileId: "default", attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt: at }, "completed");
      db.saveCheckpoint(checkpoint(id, id));
      db.appendEvent({ id: "e-" + id, runId: id, sequence: 1, at, type: "tool_finished", callId: id, output: "private-" + id, isError: false, durationMs: 1 });
    }
    const orphan = "preexisting-unreferenced";
    raw.prepare("INSERT INTO content_objects(id,payload) VALUES (?,?)").run(orphan, "unrelated orphan");
    const discardedId = vault.contentAddress(JSON.stringify("private-removed"));
    db.deleteSession("removed");
    db.purgeSession("removed");
    expect(raw.prepare("SELECT id FROM content_objects WHERE id=?").get(discardedId)).toBeUndefined();
    expect(raw.prepare("SELECT id FROM content_objects WHERE id=?").get(orphan)).toBeDefined();
    expect(raw.prepare("SELECT * FROM tool_evidence WHERE run_id='removed'").all()).toEqual([]);
    expect(db.getLatestCheckpoint("retained")).toEqual(checkpoint("retained", "retained"));
    expect(db.getToolEvidence("retained", "retained")).toMatchObject({ output: "private-retained" });
  } finally { raw.close(); db.close(); vault.dispose(); }
});
