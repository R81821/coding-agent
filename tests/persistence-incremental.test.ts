import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, SQLiteFile, VaultCrypto } from "@harness/persistence";
import type { AgentEvent } from "@harness/protocol";

// sql.js is a dependency of the persistence package, and after the engine swap it is only needed to
// build legacy fixtures - so it is resolved through that package rather than the repository root.
const require = createRequire(join(process.cwd(), "packages", "persistence", "package.json"));
const sqlJsModule = require("sql.js") as { default?: typeof import("sql.js").default } & typeof import("sql.js").default;
const initSqlJs = (sqlJsModule.default ?? sqlJsModule) as typeof import("sql.js").default;
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<{ root: string; path: string; vault: VaultCrypto }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "fixture-password");
  return { root, path: join(root, "harness.sqlite"), vault };
}

function event(runId: string, sequence: number, type: "tool_started" | "tool_finished", callId: string): AgentEvent {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  return type === "tool_started"
    ? { id: `event_${sequence}`, runId, sequence, type, at, call: { id: callId, name: "read_file", input: { path: "memory.ts" } } }
    : { id: `event_${sequence}`, runId, sequence, type, at, callId, output: { content: `output for ${callId}` }, durationMs: 12 };
}

/**
 * A database exactly as the shipped sql.js engine wrote it: same schema, same encryption AAD, and no
 * `tool_evidence` table. This is the fixture the migration has to keep readable, never a live file.
 */
async function legacyFixture(path: string, vault: VaultCrypto): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (file) => (file.endsWith(".wasm") ? require.resolve("sql.js/dist/sql-wasm.wasm") : file) });
  const database = new SQL.Database();
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence));
    CREATE INDEX events_run_type ON events(run_id, type);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE memories (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE memory_search (memory_id TEXT PRIMARY KEY, terms TEXT NOT NULL);
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const at = "2026-01-01T00:00:00.000Z";
  const run = { id: "run_legacy", sessionId: "session_legacy", request: "检查memory模块", workspacePath: "D:\\legacy", profileId: "balanced", attachments: [], budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 }, grants: [], createdAt: at };
  database.run("INSERT INTO runs (id, status, payload, created_at, updated_at) VALUES (?,?,?,?,?)", ["run_legacy", "review", vault.encryptJson(run, "run:run_legacy"), at, at]);
  const session = { id: "session_legacy", workspacePath: "D:\\legacy", profileId: "balanced", title: "检查memory模块", createdAt: at, updatedAt: at };
  database.run("INSERT INTO sessions (id, payload, updated_at) VALUES (?,?,?)", ["session_legacy", vault.encryptJson(session, "sessions:session_legacy"), at]);
  const memory = { id: "memory_legacy", scope: "project", scopeId: "project_legacy", content: "记忆模块待优化", status: "approved", pinned: true, createdAt: at, updatedAt: at };
  database.run("INSERT INTO memories (id, payload, updated_at) VALUES (?,?,?)", ["memory_legacy", vault.encryptJson(memory, "memories:memory_legacy"), at]);
  database.run("INSERT INTO checkpoints (id, payload, updated_at) VALUES (?,?,?)", ["checkpoint_legacy", vault.encryptJson({ id: "checkpoint_legacy", runId: "run_legacy", sequence: 4, reason: "manual", createdAt: at }, "checkpoints:checkpoint_legacy"), at]);
  for (const [sequence, item] of [[1, event("run_legacy", 1, "tool_started", "call_legacy")], [2, event("run_legacy", 2, "tool_finished", "call_legacy")]] as const) {
    database.run("INSERT INTO events (run_id, sequence, type, payload, created_at) VALUES (?,?,?,?,?)", ["run_legacy", sequence, item.type, vault.encryptJson(item, `event:run_legacy:${sequence}`), item.at]);
  }
  await writeFile(path, Buffer.from(database.export()));
  database.close();
}

describe("1.4 storage engine reads databases written by the sql.js engine", () => {
  it("opens a legacy sql.js file, keeps its records and resolves evidence without a full scan", async () => {
    const { path, vault } = await workspace("harness-legacy-db-");
    await legacyFixture(path, vault);
    const database = await HarnessDatabase.open(path, vault);
    try {
      expect(database.getRun("run_legacy")?.status).toBe("review");
      expect(database.listEvents("run_legacy").map((item) => item.sequence)).toEqual([1, 2]);
      expect(database.getLatestCheckpoint("run_legacy")?.id).toBe("checkpoint_legacy");
      // Session, recycle-bin and memory identity all survive the engine change.
      expect(database.getSessionDetail("session_legacy")?.session.title).toBe("检查memory模块");
      expect(database.listMemories().map((memory) => memory.id)).toEqual(["memory_legacy"]);

      // The legacy file has no evidence index: the first lookup backfills it for this run only.
      const resolve = vi.spyOn(vault, "decryptJson");
      expect(database.getToolEvidence("run_legacy", "call_legacy")).toMatchObject({ type: "tool_finished", callId: "call_legacy" });
      expect(resolve).toHaveBeenCalledTimes(2);
      resolve.mockClear();
      // The second lookup follows the pointer: one row read and one decryption.
      expect(database.getToolEvidence("run_legacy", "call_legacy")).toMatchObject({ type: "tool_finished" });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(database.getToolEvidence("run_legacy", "missing")).toBeUndefined();
      resolve.mockRestore();
    } finally {
      database.close();
      vault.dispose();
    }
  });
});

describe("incremental persistence without whole-database copies", () => {
  it("appends 300 rows without ever copying the database file", async () => {
    const { path, vault } = await workspace("harness-incremental-");
    const file = await SQLiteFile.open(path);
    try {
      file.exec("CREATE TABLE t (id INTEGER, payload TEXT)");
      const insert = file.prepare("INSERT INTO t (id, payload) VALUES (?, ?)");
      const before = file.writeFlushes;
      for (let index = 0; index < 300; index += 1) insert.run(index, "x".repeat(400));
      // sql.js exported the whole database on a timer; WAL appends only the pages it changed.
      expect(file.writeFlushes - before).toBe(0);
      expect(existsSync(`${path}-wal`)).toBe(true);
      // The rows live in the log, not in a rewritten database: the main file stays far smaller.
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(statSync(path).size);
      expect(statSync(path).size).toBeLessThan(1_000_000);
    } finally {
      file.close();
    }
    vault.dispose();
  });

  it("keeps every appended event and its evidence across a clean reopen", async () => {
    const { path, vault } = await workspace("harness-incremental-data-");
    const database = await HarnessDatabase.open(path, vault);
    try {
      database.saveRun({ id: "run_wal", sessionId: "session_wal", request: "检查memory模块", workspacePath: "D:\\wal", profileId: "balanced", attachments: [], budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 }, grants: [], createdAt: "2026-01-01T00:00:00.000Z" }, "running");
      for (let sequence = 0; sequence < 300; sequence += 1) {
        database.appendEvent(sequence % 2 === 0 ? event("run_wal", sequence, "tool_started", `call_${sequence}`) : event("run_wal", sequence, "tool_finished", `call_${sequence}`));
      }
      // Writes are committed as they happen, not held for a periodic whole-file export.
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(database.listEvents("run_wal")).toHaveLength(300);
    } finally {
      database.close();
    }
    // A clean shutdown checkpoints the log away, so the file alone carries every committed row.
    const log = `${path}-wal`;
    expect(existsSync(log) ? readFileSync(log).byteLength : 0).toBe(0);
    const reopened = await HarnessDatabase.open(path, vault);
    try {
      expect(reopened.listEvents("run_wal")).toHaveLength(300);
      expect(reopened.getToolEvidence("run_wal", "call_299")).toMatchObject({ type: "tool_finished", callId: "call_299" });
    } finally {
      reopened.close();
      vault.dispose();
    }
  });

  it("keeps committed rows when the writer never closes cleanly", async () => {
    const { path, vault } = await workspace("harness-crash-");
    const seed = await HarnessDatabase.open(path, vault);
    seed.saveRun({ id: "run_crash", sessionId: "session_crash", request: "检查memory模块", workspacePath: "D:\\crash", profileId: "balanced", attachments: [], budget: { maxTurns: 8, maxToolCalls: 16, maxDurationMs: 60000, maxUsd: 1 }, grants: [], createdAt: "2026-01-01T00:00:00.000Z" }, "running");
    seed.close();

    // A second process commits a row and exits without closing the database, the way the daemon died.
    const script = [
      "const { DatabaseSync } = require('node:sqlite');",
      "const db = new DatabaseSync(process.argv[1]);",
      "db.exec('PRAGMA journal_mode = WAL');",
      "db.exec('PRAGMA synchronous = FULL');",
      "db.prepare('INSERT INTO events (run_id, sequence, type, payload, created_at) VALUES (?,?,?,?,?)').run('run_crash', 7, 'status', 'committed-before-crash', '2026-01-01T00:00:07.000Z');",
      "process.exit(0);",
    ].join("\n");
    await new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, ["-e", script, path], { stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`child exited with ${code}`))));
    });
    expect(existsSync(`${path}-wal`)).toBe(true);

    // Recovery happens on open: the committed row is readable from the file without any close.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("SELECT payload FROM events WHERE run_id=? AND sequence=?").get("run_crash", 7)).toMatchObject({ payload: "committed-before-crash" });
    } finally {
      raw.close();
    }
    const recovered = await HarnessDatabase.open(path, vault);
    try {
      expect(recovered.getRun("run_crash")?.status).toBe("running");
    } finally {
      recovered.close();
      vault.dispose();
    }
  });
});
