import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { buildSessionContext } from "@harness/core";
import { DEFAULT_PROFILE, type AgentEvent, type AgentEventInput, type MemoryRecord, type RunSpec, type RunStatus } from "@harness/protocol";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const at = "2026-10-11T00:00:00.000Z";
function spec(id: string, index: number, parentRunId?: string): RunSpec {
  return { id, sessionId: "session", request: `request ${id}`, workspacePath: "D:/withdraw-fixture", profileId: "default", attachments: [], grants: [], budget: DEFAULT_PROFILE.budget,
    createdAt: new Date(Date.parse(at) + index * 1000).toISOString(), ...(parentRunId ? { parentRunId } : {}) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-withdraw-db-"));
  const crypto = await VaultCrypto.open(join(root, "key.json"), "fixture-passphrase");
  let database = await HarnessDatabase.open(join(root, "data.sqlite"), crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  database.createSession({ id: "session", workspacePath: "D:/withdraw-fixture", profileId: "default", title: "session", createdAt: at, updatedAt: at });
  return { get database() { return database; }, async reopen() { database.close(); database = await HarnessDatabase.open(join(root, "data.sqlite"), crypto); return database; } };
}
function event(database: HarnessDatabase, runId: string, sequence: number, data: AgentEventInput) {
  database.appendEvent({ id: `${runId}-${sequence}`, runId, sequence, at, ...data } as AgentEvent);
}
function memory(id: string, source: string): MemoryRecord {
  return { id, source, scope: "session", scopeId: "session", content: `memory ${id}`, confidence: 1, status: "approved", pinned: false, createdAt: at };
}

describe("latest paused conversation withdrawal persistence", () => {
  it("hides the entire run tree, preserves actual usage and original attachments, and removes its memories after reopening", async () => {
    const state = await fixture(), database = state.database;
    database.saveRun(spec("prior", 0), "completed");
    event(database, "prior", 0, { type: "result", status: "completed", text: "prior answer" });
    const latest: RunSpec = { ...spec("latest", 1), attachments: [{ id: "image", mimeType: "image/png", byteLength: 10, sha256: "a".repeat(64), encryptedPath: "fixture.enc", source: "clipboard", trust: "user_request", createdAt: at, allowedProviders: [] }], taskMode: "change" };
    database.saveRun(latest, "paused");
    database.saveRun(spec("child", 2, "latest"), "completed");
    database.saveRun(spec("grandchild", 3, "child"), "paused");
    event(database, "latest", 0, { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, estimatedUsd: .1, purpose: "main" } });
    event(database, "latest", 1, { type: "context_usage", context: { usedTokens: 900000, capacityTokens: 1000000, source: "provider" } });
    event(database, "latest", 2, { type: "result", status: "paused", text: "private withdrawn answer" });
    event(database, "latest", 3, { type: "context_compacted", record: {
      id: "compaction", runId: "latest", sourceSequenceStart: 0, sourceSequenceEnd: 2,
      summary: "private withdrawn summary", summaryHash: "hash", inputTokens: 60, outputTokens: 10,
      deterministicFallback: false, trust: "untrusted_tool", createdAt: at,
    } });
    event(database, "child", 0, { type: "usage", usage: { inputTokens: 30, outputTokens: 5, estimatedUsd: .01, purpose: "main" } });
    database.saveMemory(memory("removed", "run:child"));
    database.saveMemory(memory("kept", "run:prior"));
    const withdrawn = database.withdrawLatestRun("latest");
    expect(withdrawn).toEqual({ run: latest, withdrawnRunIds: ["latest", "child", "grandchild"] });
    for (const id of withdrawn.withdrawnRunIds) {
      expect(database.getRun(id)).toBeUndefined();
      expect(database.isRunWithdrawn(id)).toBe(true);
    }
    expect(database.getSessionView("session")?.runs.map(run => run.spec.id)).toEqual(["prior"]);
    expect(database.getSessionDetail("session")?.runs.map(run => run.spec.id)).toEqual(["prior"]);
    expect(database.listRunHistory().items.map(run => run.id)).toEqual(["prior"]);
    expect(database.listSessions().items[0]).toMatchObject({ runCount: 1, latestRunId: "prior", latestStatus: "completed" });
    expect(database.listMemories().map(item => item.id)).toEqual(["kept"]);
    expect(database.getSessionView("session")?.withdrawnEvents?.map(item => item.type).sort()).toEqual(["context_compacted", "usage", "usage"]);
    expect(JSON.stringify(database.getSessionView("session")?.withdrawnEvents)).not.toContain("private withdrawn answer");
    expect(JSON.stringify(database.getSessionView("session")?.withdrawnEvents)).not.toContain("private withdrawn summary");
    expect(database.listEvents("latest")).toHaveLength(4); // Retained encrypted audit, never model history.
    const reopened = await state.reopen();
    expect(reopened.getRun("latest")).toBeUndefined();
    expect(reopened.getSessionView("session")?.withdrawnEvents).toHaveLength(3);
    expect(() => reopened.saveRun(latest)).toThrow("已撤回");
    expect(() => reopened.updateRunStatus("latest", "running")).toThrow("已撤回");
    reopened.saveRun(spec("next", 4));
    const context = JSON.stringify(buildSessionContext(reopened.getSessionDetail("session"), "next"));
    expect(context).toContain("request prior");
    expect(context).toContain("prior answer");
    expect(context).not.toContain("request latest");
    expect(context).not.toContain("request child");
    expect(context).not.toContain("withdrawn answer");
  });

  it.each<RunStatus>(["queued", "planning", "running", "verifying", "waiting_approval", "completed", "review", "failed", "cancelled"])("rejects a %s round without removing it", async status => {
    const { database } = await fixture();
    database.saveRun(spec("latest", 1), status);
    expect(() => database.withdrawLatestRun("latest")).toThrow("只能撤回");
    expect(database.getRun("latest")?.status).toBe(status);
    expect(database.isRunWithdrawn("latest")).toBe(false);
  });

  it("rejects an older paused round and a child, but a newer child does not prevent withdrawing the latest main round", async () => {
    const { database } = await fixture();
    database.saveRun(spec("older", 1), "paused");
    database.saveRun(spec("latest", 2), "paused");
    database.saveRun(spec("child", 3, "latest"), "paused");
    expect(() => database.withdrawLatestRun("older")).toThrow("最新");
    expect(() => database.withdrawLatestRun("child")).toThrow("只能撤回");
    expect(database.withdrawLatestRun("latest").withdrawnRunIds).toEqual(["latest", "child"]);
    expect(database.getRun("older")).toBeDefined();
  });

  it("refuses to commit while a descendant is live or the session/project is hidden", async () => {
    const { database } = await fixture();
    database.saveRun(spec("latest", 1), "paused");
    database.saveRun(spec("child", 2, "latest"), "running");
    expect(() => database.withdrawLatestRun("latest")).toThrow("暂停完成");
    expect(database.getRun("latest")?.status).toBe("paused");
    database.updateRunStatus("child", "paused");
    database.deleteSession("session");
    expect(() => database.withdrawLatestRun("latest")).toThrow("会话不存在或已删除");
    database.restoreSession("session");
    database.deleteProject(database.listProjects()[0]!.id);
    expect(() => database.withdrawLatestRun("latest")).toThrow("会话不存在或已删除");
    expect(database.getRun("latest")).toBeDefined();
  });

  it("finds all descendants across session boundaries so an unfinished child cannot escape withdrawal checks", async () => {
    const { database } = await fixture();
    database.createSession({ id: "other", workspacePath: "D:/withdraw-fixture", profileId: "default", title: "other", createdAt: at, updatedAt: at });
    database.saveRun(spec("latest", 1), "paused");
    database.saveRun({ ...spec("child", 2, "latest"), sessionId: "other" }, "running");
    database.saveRun({ ...spec("grandchild", 3, "child"), sessionId: "other" }, "paused");
    expect(database.getRunDescendants("latest").map(run => run.spec.id)).toEqual(["latest", "child", "grandchild"]);
    expect(database.getRunDescendants("missing")).toEqual([]);
    expect(() => database.withdrawLatestRun("latest")).toThrow("暂停完成");
    database.updateRunStatus("child", "paused");
    expect(database.withdrawLatestRun("latest").withdrawnRunIds).toEqual(["latest", "child", "grandchild"]);
    expect(database.getRunDescendants("latest")).toEqual([]);
    expect(database.getSessionView("other")?.runs).toEqual([]);
    database.deleteSession("session");
    expect(database.purgeSession("session").runs).toBe(1);
    expect(database.getRun("child")).toBeUndefined();
    expect(database.isRunWithdrawn("child")).toBe(true);
    expect(database.getSessionView("other")?.runs).toEqual([]);
    database.deleteSession("other");
    expect(database.purgeSession("other").runs).toBe(2);
    expect(database.isRunWithdrawn("child")).toBe(false);
  });

  it("keeps paginated visible history full and purges retained withdrawn audit with the session", async () => {
    const { database } = await fixture();
    for (let index = 0; index < 25; index++) database.saveRun(spec(`prior-${index}`, index), "completed");
    database.saveRun(spec("latest", 30), "paused");
    event(database, "latest", 0, { type: "result", status: "paused", text: "withdrawn" });
    database.withdrawLatestRun("latest");
    const page = database.getSessionView("session")!;
    expect(page.runs).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.runs.some(run => run.spec.id === "latest")).toBe(false);
    expect(database.getSessionView("session", 20, page.before)?.runs).toHaveLength(5);
    database.deleteSession("session");
    expect(database.purgeSession("session").runs).toBe(26);
    expect(database.listEvents("latest")).toEqual([]);
    expect(database.isRunWithdrawn("latest")).toBe(false);
  });
});
