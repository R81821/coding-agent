import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, DaemonRequestSchema, type AgentEvent, type RunHistoryItem, type RunSpec } from "@harness/protocol";
import { isLiveRun, mergeRunEvents, mergeRunHistory } from "../apps/desktop/src/run-history.js";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

function spec(id: string, createdAt = "2026-09-01T00:00:00.000Z"): RunSpec {
  return { id, sessionId: `session-${id}`, request: `private historical request ${id}`, workspacePath: `D:/workspace-${id}`, profileId: "default", attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt };
}
const item = (id: string): RunHistoryItem => ({ ...spec(id), status: "completed" });
function event(runId: string, sequence: number): AgentEvent {
  return { id: `${runId}-${sequence}`, runId, sequence, at: "2026-09-01T00:00:00.000Z", type: "text_delta", delta: `${runId} response ${sequence}` };
}

describe("persistent run history", () => {
  it("recovers old runs and messages after reopening the database, with stable pagination", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-history-"));
    const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
    const path = join(root, "db.sqlite");
    let database = await HarnessDatabase.open(path, vault);
    try {
      database.saveRun(spec("old-a"), "completed");
      database.appendEvent(event("old-a", 0));
      database.saveRun(spec("old-b"), "failed");
      database.appendEvent(event("old-b", 0));
      database.saveRun(spec("new", "2026-09-02T00:00:00.000Z"), "review");
      database.close();
      database = await HarnessDatabase.open(path, vault);
      const first = database.listRunHistory(2, 0);
      const second = database.listRunHistory(2, 2);
      expect(first.items.map((row) => row.id)).toEqual(["new", "old-b"]);
      expect(first.hasMore).toBe(true);
      expect(second.items.map((row) => row.id)).toEqual(["old-a"]);
      expect(second.hasMore).toBe(false);
      expect(database.getRun("old-a")).toEqual({ spec: spec("old-a"), status: "completed" });
      expect(database.listEvents("old-a")).toEqual([event("old-a", 0)]);
      expect(first.items[0]).not.toHaveProperty("grants");
      expect(first.items[0]).not.toHaveProperty("budget");
      expect(database.getRun("missing")).toBeUndefined();
      expect(() => database.listRunHistory(201)).toThrow("pagination");
      expect(() => database.listRunHistory(1, -1)).toThrow("pagination");
      expect((await readFile(path)).includes(Buffer.from("private historical request"))).toBe(false);
    } finally {
      database.close(); vault.dispose();
      const rel = relative(tmpdir(), root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes read-only history methods through the validated renderer boundary", () => {
    expect(sanitizeRendererRequest("runs.list", { limit: 50, offset: 0 }).method).toBe("runs.list");
    expect(sanitizeRendererRequest("run.get", { runId: "old-a" }).method).toBe("run.get");
    expect(DaemonRequestSchema.parse({ id: "q", method: "runs.list", params: {} })).toMatchObject({ params: { limit: 50, offset: 0 } });
    expect(() => DaemonRequestSchema.parse({ id: "q", method: "runs.list", params: { offset: -1 } })).toThrow();
    expect(() => sanitizeRendererRequest("runs.delete", {})).toThrow("cannot invoke");
  });
});

describe("history switching state", () => {
  it("keeps older loaded pages and updates statuses when the newest page refreshes", () => {
    const current = { items: [item("b"), item("a")], hasMore: true };
    const updated = mergeRunHistory(current, { items: [{ ...item("b"), status: "review" }], hasMore: true }, false);
    expect(updated.items.map((row) => row.id)).toEqual(["b", "a"]);
    expect(updated.items[0]?.status).toBe("review");
    const next = mergeRunHistory(updated, { items: [item("a"), item("0")], hasMore: false }, true);
    expect(next.items.map((row) => row.id)).toEqual(["b", "a", "0"]);
    expect(next.hasMore).toBe(false);
    expect(current.items[0]?.status).toBe("completed");
  });

  it("merges reopened history with polling without mixing runs or duplicating events", () => {
    const events = mergeRunEvents([event("a", 0), event("a", 1)], [event("a", 1), event("b", 2), event("a", 2)], "a");
    expect(events).toEqual([event("a", 0), event("a", 1), event("a", 2)]);
    expect(mergeRunEvents(events, [event("b", 0)], "b")).toEqual([event("b", 0)]);
  });

  it("only polls live runs, not completed, interrupted, or review histories", () => {
    expect(isLiveRun("running")).toBe(true);
    expect(isLiveRun("waiting_approval")).toBe(true);
    for (const status of ["completed", "cancelled", "failed", "paused", "review"] as const) expect(isLiveRun(status)).toBe(false);
  });
});
