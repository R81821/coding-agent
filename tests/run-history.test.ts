import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, DaemonRequestSchema, type AgentEvent, type ProjectRecord, type RunHistoryItem, type RunSpec, type SessionDetail, type SessionSummary } from "@harness/protocol";
import { groupRunHistory, groupSessionsByProject, isLiveRun, mergeRunEvents, mergeRunHistory, mergeSessionPages, sessionTurns, workspaceKey } from "../apps/desktop/src/run-history.js";
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
  it("groups conversations under their project and puts the current project first", () => {
    const alpha = { ...item("alpha"), workspacePath: "D:\\Code\\Alpha" };
    const alphaOlder = { ...item("alpha-old"), workspacePath: "d:/code/alpha/" };
    const beta = { ...item("beta"), workspacePath: "D:/Code/Beta" };
    const groups = groupRunHistory([beta, alpha, alphaOlder], "D:/CODE/ALPHA");
    expect(groups.map((group) => group.key)).toEqual([workspaceKey("D:/Code/Alpha"), workspaceKey("D:/Code/Beta")]);
    expect(groups[0]?.workspacePath).toBe("D:/CODE/ALPHA");
    expect(groups[0]?.items.map((row) => row.id)).toEqual(["alpha", "alpha-old"]);
    expect(groupRunHistory([beta], "D:/Code/Empty")[0]).toMatchObject({ workspacePath: "D:/Code/Empty", items: [] });
  });

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

describe("Session-oriented renderer state", () => {
  const session = (id: string, workspacePath: string, updatedAt: string, latestStatus: SessionSummary["latestStatus"] = "completed"): SessionSummary => ({
    id,
    workspacePath,
    profileId: "default",
    title: `Session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    runCount: 1,
    latestRunId: `run-${id}`,
    latestStatus,
  });
  const project = (id: string, workspacePath: string): ProjectRecord => ({ id, workspacePath, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });

  it("groups Session summaries under project records and keeps the current project first", () => {
    const alpha = project("project-alpha", "D:/Code/Alpha");
    const beta = project("project-beta", "D:/Code/Beta");
    const groups = groupSessionsByProject([
      session("alpha", "d:\\code\\alpha", "2026-09-03T00:00:00.000Z"),
      session("beta", "D:/Code/Beta", "2026-09-02T00:00:00.000Z", "running"),
    ], [beta, alpha], "D:/CODE/ALPHA/");

    expect(groups.map((group) => group.project.id)).toEqual(["project-alpha", "project-beta"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["alpha"]);
    expect(groups[1]?.items[0]?.latestStatus).toBe("running");
  });

  it("merges Session pages by Session id and derives separated multi-run turns", () => {
    const older = session("same", "D:/Code/Alpha", "2026-09-01T00:00:00.000Z");
    const newer = { ...older, title: "Updated title", updatedAt: "2026-09-04T00:00:00.000Z", runCount: 2 };
    expect(mergeSessionPages({ items: [older], hasMore: false }, { items: [newer], hasMore: false }, false).items).toEqual([newer]);

    const firstSpec = { ...spec("turn-one"), sessionId: "same", request: "first prompt" };
    const secondSpec = { ...spec("turn-two"), sessionId: "same", request: "second prompt", createdAt: "2026-09-02T00:00:00.000Z" };
    const detail: SessionDetail = {
      session: older,
      runs: [
        { spec: firstSpec, status: "completed", events: [event(firstSpec.id, 0)] },
        { spec: secondSpec, status: "failed", events: [event(secondSpec.id, 0)] },
      ],
    };
    expect(sessionTurns(detail)).toEqual([
      { runId: firstSpec.id, request: "first prompt", status: "completed", events: [event(firstSpec.id, 0)] },
      { runId: secondSpec.id, request: "second prompt", status: "failed", events: [event(secondSpec.id, 0)] },
    ]);
  });
});

describe("persistent sessions and project recycle state", () => {
  it("persists empty sessions, groups multiple runs, and restores soft-deleted records", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sessions-"));
    const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
    const path = join(root, "db.sqlite");
    let database = await HarnessDatabase.open(path, vault);
    try {
      const createdAt = "2026-09-08T01:00:00.000Z";
      const workspacePath = "D:/Code/SessionProject";
      const project = database.ensureProject(workspacePath, createdAt);
      database.createSession({ id: "session-a", workspacePath, profileId: "default", title: "新会话", createdAt, updatedAt: createdAt });
      database.saveRun({ ...spec("turn-a", createdAt), sessionId: "session-a", workspacePath, request: "first turn" }, "completed");
      database.saveRun({ ...spec("turn-b", "2026-09-08T01:01:00.000Z"), sessionId: "session-a", workspacePath, request: "second turn" }, "review");
      database.touchSession("session-a", { title: "first turn", profileId: "default", updatedAt: "2026-09-08T01:01:00.000Z" });

      database.close();
      database = await HarnessDatabase.open(path, vault);
      expect(database.listProjects(false)).toEqual([expect.objectContaining({ id: project.id, workspacePath })]);
      expect(database.listSessions({ deleted: false, limit: 50, offset: 0 })).toMatchObject({
        hasMore: false,
        items: [{ id: "session-a", title: "first turn", runCount: 2, latestRunId: "turn-b", latestStatus: "review" }],
      });
      expect(database.getSessionDetail("session-a")?.runs.map((run) => run.spec.id)).toEqual(["turn-a", "turn-b"]);

      database.deleteSession("session-a");
      expect(database.listSessions({ deleted: false, limit: 50, offset: 0 }).items).toEqual([]);
      expect(database.listSessions({ deleted: true, limit: 50, offset: 0 }).items[0]).toMatchObject({ id: "session-a" });
      database.restoreSession("session-a");
      expect(database.getSessionDetail("session-a")?.runs).toHaveLength(2);

      database.deleteProject(project.id);
      expect(database.listProjects(false)).toEqual([]);
      expect(database.listProjects(true)[0]).toMatchObject({ id: project.id, workspacePath });
      database.restoreProject(project.id);
      expect(database.listProjects(false)[0]).toMatchObject({ id: project.id, workspacePath });
    } finally {
      database.close(); vault.dispose();
      const rel = relative(tmpdir(), root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy runs into sessions without rewriting their payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-migration-"));
    const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
    const path = join(root, "db.sqlite");
    let database = await HarnessDatabase.open(path, vault);
    try {
      database.saveRun({ ...spec("legacy-a"), sessionId: "legacy-session", workspacePath: "D:/Legacy" }, "completed");
      database.close();
      database = await HarnessDatabase.open(path, vault);
      expect(database.listSessions({ deleted: false, limit: 50, offset: 0 }).items[0]).toMatchObject({ id: "legacy-session", runCount: 1 });
      expect(database.getRun("legacy-a")?.spec.sessionId).toBe("legacy-session");
    } finally {
      database.close(); vault.dispose();
      const rel = relative(tmpdir(), root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks deletion while running and purges run data without touching memories", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-purge-"));
    const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
    const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
    try {
      const createdAt = "2026-09-08T01:00:00.000Z";
      const workspacePath = "D:/Code/PurgeProject";
      const project = database.ensureProject(workspacePath, createdAt);
      database.createSession({ id: "session-purge", workspacePath, profileId: "default", title: "purge", createdAt, updatedAt: createdAt });
      database.saveRun({ ...spec("live", createdAt), sessionId: "session-purge", workspacePath }, "running");
      expect(() => database.deleteSession("session-purge")).toThrow("active run");
      expect(() => database.deleteProject(project.id)).toThrow("active run");
      database.updateRunStatus("live", "completed");
      database.appendEvent(event("live", 0));
      database.saveMemory({ id: "keep-memory", content: "keep session knowledge", source: "run:live", scope: "session", scopeId: "session-purge", confidence: 1, status: "approved", pinned: false, approvedBy: "fixture", createdAt });
      database.deleteSession("session-purge");

      const result = database.purgeSession("session-purge");
      expect(result).toMatchObject({ sessionId: "session-purge", runs: 1 });
      expect(database.getSessionDetail("session-purge")).toBeUndefined();
      expect(database.getRun("live")).toBeUndefined();
      expect(database.listEvents("live")).toEqual([]);
      expect(database.listMemories().map((memory) => memory.id)).toContain("keep-memory");
      expect(database.searchMemories("session knowledge", ["session-purge"]).map((memory) => memory.id)).toContain("keep-memory");
    } finally {
      database.close(); vault.dispose();
      const rel = relative(tmpdir(), root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
});
