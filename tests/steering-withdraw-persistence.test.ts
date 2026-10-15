import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, PlanSpecSchema, WorkflowStateSchema, type AgentEvent, type AgentEventInput, type CompactionRecord, type MemoryRecord, type RunCheckpoint, type RunSpec } from "@harness/protocol";

const at = "2026-10-15T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function run(id = "run", parentRunId?: string, index = 0): RunSpec {
  return { id, sessionId: "session", request: "原始请求", workspacePath: "D:/fixture", profileId: "default", budget: DEFAULT_PROFILE.budget,
    grants: [], attachments: [], createdAt: new Date(Date.parse(at) + index * 1000).toISOString(), ...(parentRunId ? { parentRunId } : {}) };
}
function checkpoint(sequence: number, text = "暂停前上下文", runId = "run"): RunCheckpoint {
  return { id: `checkpoint-${runId}-${sequence}`, runId, sequence, reason: "manual", status: "paused", transcript: [{ role: "user", content: [{ type: "text", trust: "user_request", text }] }],
    usage: { inputTokens: 100 + sequence, outputTokens: 20 + sequence, estimatedUsd: sequence / 100 }, turns: 1 + sequence, toolCalls: sequence,
    pendingNonIdempotentToolCalls: [], pendingSteering: [], createdAt: at };
}
function event(database: HarnessDatabase, sequence: number, data: AgentEventInput, runId = "run") {
  database.appendEvent({ id: `${runId}-${sequence}`, runId, sequence, at, ...data } as AgentEvent);
}
function memory(id: string, source = "run:run"): MemoryRecord {
  return { id, source, scope: "session", scopeId: "session", content: id, confidence: 1, status: "approved", pinned: false, createdAt: at };
}
function compaction(id: string): CompactionRecord {
  return { id, runId: "run", sourceSequenceStart: 0, sourceSequenceEnd: 3, summary: `summary ${id}`, summaryHash: id, inputTokens: 10, outputTokens: 2, deterministicFallback: false, trust: "untrusted_tool", createdAt: at };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-steering-withdraw-db-")), path = join(root, "data.sqlite");
  const crypto = await VaultCrypto.open(join(root, "key.json"), "fixture-passphrase");
  let database = await HarnessDatabase.open(path, crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  database.createSession({ id: "session", title: "fixture", workspacePath: "D:/fixture", profileId: "default", createdAt: at, updatedAt: at });
  database.saveRun(run(), "paused");
  database.saveCheckpoint(checkpoint(0));
  event(database, 0, { type: "result", status: "paused", text: "原有工作已暂停" });
  return { get database() { return database; }, crypto, path, async reopen() { database.close(); database = await HarnessDatabase.open(path, crypto); return database; } };
}
function submit(database: HarnessDatabase, messageId = "message", sequence = 1, text = "误发的新消息") {
  database.prepareSteeringWithdrawal("run", messageId, database.getLatestCheckpoint("run")!.id);
  event(database, sequence, { type: "steering_submitted", messageId, text });
  database.saveCheckpoint({ ...checkpoint(sequence, text), pendingSteering: [{ id: messageId, text }] });
}

describe("paused additional-message withdrawal persistence", () => {
  it("restores only the latest message branch, preserves spent budget, and survives restart", async () => {
    const state = await fixture(), db = state.database;
    const baseline = { ...checkpoint(0), elapsedMs: 20, repairAttemptsUsed: 1, planVersion: 1,
      workflow: WorkflowStateSchema.parse({ phase: "small_edit", objective: "original objective", requirements: [], context: "original context", plan: [], hypotheses: [], observations: [], relevantFiles: [], changedFiles: [], revision: 1, localRevision: 0, broaderRevision: 0, diffRevision: 0, requirementsRevision: 0, reviewedRevision: 0, failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "" }) };
    db.saveCheckpoint(baseline);
    submit(db);
    event(db, 2, { type: "steering_delivered", messageId: "message", text: "误发的新消息" });
    event(db, 3, { type: "text_delta", delta: "不应保留的回答" });
    event(db, 4, { type: "usage", usage: { inputTokens: 30, outputTokens: 4, estimatedUsd: .04, purpose: "main" } });
    event(db, 5, { type: "context_compacted", record: compaction("removed") });
    db.saveCheckpoint({ ...checkpoint(6, "不应保留的模型上下文"), elapsedMs: 500, repairAttemptsUsed: 3, planVersion: 2 });
    const withdrawn = db.withdrawLatestSteering("run", "message");
    expect(withdrawn).toEqual({ run: run(), withdrawnRunIds: [], messageId: "message", text: "误发的新消息" });
    expect(db.getRun("run")?.status).toBe("paused");
    const restored = db.getLatestCheckpoint("run")!;
    expect(restored).toMatchObject({ transcript: baseline.transcript, workflow: baseline.workflow, planVersion: 1, pendingSteering: [], usage: checkpoint(6).usage, turns: 7, toolCalls: 6, elapsedMs: 500, repairAttemptsUsed: 3 });
    expect(restored.sequence).toBeGreaterThan(6);
    expect(db.listCheckpoints("run").map(item => item.id)).toEqual([restored.id, baseline.id]);
    expect(db.getSteeringWithdrawal("run", "message")).toBeUndefined();
    expect(JSON.stringify(db.listEvents("run"))).not.toContain("误发");
    expect(JSON.stringify(db.getSessionDetail("session"))).not.toContain("不应保留");
    expect(db.getSessionView("session")?.withdrawnEvents?.map(item => item.type)).toEqual(["usage", "context_compacted"]);
    expect(JSON.stringify(db.getSessionView("session")?.withdrawnEvents)).not.toContain("summary removed");
    const reopened = await state.reopen();
    expect(reopened.getLatestCheckpoint("run")).toEqual(restored);
    expect(reopened.getSessionView("session")?.withdrawnEvents).toHaveLength(2);
  });

  it("retains earlier human messages when successive withdrawals return to each paused boundary", async () => {
    const { database: db } = await fixture();
    submit(db, "first", 1, "保留的第一条");
    event(db, 2, { type: "text_delta", delta: "第一条之后的工作" });
    db.saveCheckpoint(checkpoint(3, "第一条之后的上下文"));
    submit(db, "second", 4, "撤回第二条");
    event(db, 5, { type: "usage", usage: { inputTokens: 10, outputTokens: 3, estimatedUsd: .01 } });
    db.saveCheckpoint(checkpoint(6, "第二条之后的上下文"));
    db.withdrawLatestSteering("run", "second");
    expect(JSON.stringify(db.listEvents("run"))).toContain("保留的第一条");
    expect(JSON.stringify(db.listEvents("run"))).not.toContain("撤回第二条");
    expect(db.getSteeringWithdrawal("run")?.messageId).toBe("first");
    const secondWithdrawalSequence = db.getLatestCheckpoint("run")!.sequence;
    db.withdrawLatestSteering("run", "first");
    expect(db.getLatestCheckpoint("run")!.sequence).toBeGreaterThan(secondWithdrawalSequence);
    expect(db.getLatestCheckpoint("run")!.usage).toEqual(checkpoint(6).usage);
    expect(db.getSessionView("session")?.withdrawnEvents).toHaveLength(1);
    expect(db.listEvents("run").filter(item => item.type === "steering_submitted")).toEqual([]);
  });

  it("preserves old child runs, withdraws only new descendants and removes only new memories", async () => {
    const { database: db } = await fixture();
    db.saveRun(run("old-child", "run", 1), "paused");
    db.saveCheckpoint(checkpoint(0, "old child context", "old-child"));
    event(db, 0, { type: "text_delta", delta: "old child output" }, "old-child");
    db.saveMemory(memory("old-memory"));
    db.saveMemory(memory("old-child-memory", "run:old-child"));
    submit(db);
    db.saveRun(run("new-child", "run", 2), "completed");
    db.saveRun(run("grandchild", "new-child", 3), "paused");
    event(db, 0, { type: "usage", usage: { inputTokens: 11, outputTokens: 2, estimatedUsd: .01 } }, "new-child");
    event(db, 1, { type: "text_delta", delta: "old child continued output" }, "old-child");
    event(db, 2, { type: "usage", usage: { inputTokens: 9, outputTokens: 1, estimatedUsd: .01 } }, "old-child");
    db.saveCheckpoint(checkpoint(3, "old child continued context", "old-child"));
    db.saveMemory(memory("new-memory"));
    db.saveMemory(memory("new-child-memory", "run:new-child"));
    db.saveMemory(memory("unrelated-memory", "manual"));
    expect(db.withdrawLatestSteering("run", "message").withdrawnRunIds).toEqual(["new-child", "grandchild"]);
    expect(db.getRun("old-child")?.status).toBe("paused");
    expect(db.getLatestCheckpoint("old-child")?.transcript).toEqual(checkpoint(0, "old child context", "old-child").transcript);
    expect(db.getLatestCheckpoint("old-child")?.usage).toEqual(checkpoint(3).usage);
    expect(db.listEvents("old-child").filter(item => item.type === "text_delta")).toMatchObject([{ delta: "old child output" }]);
    expect(db.getRun("new-child")).toBeUndefined();
    expect(db.getRun("grandchild")).toBeUndefined();
    expect(db.listMemories().map(item => item.id).sort()).toEqual(["old-child-memory", "old-memory", "unrelated-memory"]);
    expect(db.getSessionView("session")?.withdrawnEvents).toHaveLength(2);
  });

  it("restores overwritten plans and removes branch verification, compaction, traces and evidence", async () => {
    const { database: db } = await fixture();
    const plan = PlanSpecSchema.parse({ id: "plan", runId: "run", goal: "original goal", version: 1, status: "approved", steps: [{ id: "step", title: "step", description: "step", mode: "write", outputContract: "done" }], scope: {}, createdAt: at, updatedAt: at });
    db.savePlan(plan);
    db.saveCompaction(compaction("kept"));
    db.appendTrace({ id: "old-trace", runId: "run", type: "fixture", at, attributes: { text: "old" } });
    submit(db);
    db.savePlan({ ...plan, goal: "removed goal", version: 2 });
    db.savePlan({ ...plan, id: "new-plan", goal: "new removed goal", version: 3 });
    db.saveCompaction(compaction("removed"));
    db.saveVerificationRun({ id: "new-verification", runId: "run", attempt: 0, results: [], passed: true, startedAt: at, finishedAt: at });
    db.appendTrace({ id: "new-trace", runId: "run", type: "fixture", at, attributes: { text: "removed trace" } });
    event(db, 2, { type: "tool_finished", callId: "removed-call", durationMs: 1, output: { content: "removed tool output" } });
    db.withdrawLatestSteering("run", "message");
    expect(db.getPlanForRun("run")).toEqual(plan);
    expect(db.getPlan("new-plan")).toBeUndefined();
    expect(db.listCompactions("run").map(item => item.id)).toEqual(["kept"]);
    expect(db.listVerificationRuns("run")).toEqual([]);
    expect(db.queryTraces({ runId: "run" }).map(item => item.id)).toEqual(["old-trace"]);
    expect(db.getToolEvidence("run", "removed-call")).toBeUndefined();
    expect(JSON.stringify(db.listEventPage("run"))).not.toContain("removed tool output");
  });

  it("retains existing child accounting watermarks while restoring its previous task state", async () => {
    const { database: db } = await fixture();
    const beforeUsage = { inputTokens: 10, outputTokens: 2, estimatedUsd: .1, turns: 1, toolCalls: 1, costKnown: true };
    const afterUsage = { inputTokens: 30, outputTokens: 5, estimatedUsd: .4, turns: 3, toolCalls: 4, costKnown: false };
    const workflow = WorkflowStateSchema.parse({
      phase: "small_edit", objective: "original objective", requirements: [], context: "original context", plan: [], hypotheses: [], observations: [], relevantFiles: [], changedFiles: [], revision: 1,
      localRevision: 0, broaderRevision: 0, diffRevision: 0, requirementsRevision: 0, reviewedRevision: 0, failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "",
      sequential: { taskExecutions: [{ stepId: "step", taskId: "task", childRunId: "child", mode: "write", status: "interrupted", startedAt: at, summary: "original summary", accountedUsage: beforeUsage }] },
    });
    db.saveRun(run("child", "run", 1), "paused");
    db.saveCheckpoint({ ...checkpoint(0), workflow });
    submit(db);
    db.saveCheckpoint({ ...checkpoint(3), workflow: { ...workflow, sequential: { ...workflow.sequential!, taskExecutions: [{ ...workflow.sequential!.taskExecutions[0]!, status: "completed", summary: "removed summary", accountedUsage: afterUsage }] } } });
    db.withdrawLatestSteering("run", "message");
    expect(db.getLatestCheckpoint("run")!.workflow!.sequential!.taskExecutions[0]).toMatchObject({
      childRunId: "child", status: "interrupted", summary: "original summary", accountedUsage: afterUsage,
    });
  });

  it("does not select an older delivered message over a newer submitted message", async () => {
    const { database: db } = await fixture();
    submit(db, "first", 1);
    db.saveCheckpoint(checkpoint(2));
    submit(db, "second", 3);
    event(db, 4, { type: "steering_delivered", messageId: "first", text: "first" });
    expect(db.getSteeringWithdrawal("run")?.messageId).toBe("second");
    expect(() => db.withdrawLatestSteering("run", "first")).toThrow("最新一条");
    expect(db.withdrawLatestSteering("run", "second").messageId).toBe("second");
  });

  it("counts withdrawn billing once when the remaining original round is withdrawn later", async () => {
    const { database: db } = await fixture();
    event(db, 1, { type: "usage", usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: .1 } });
    db.saveCheckpoint(checkpoint(2));
    submit(db, "message", 3);
    event(db, 4, { type: "usage", usage: { inputTokens: 30, outputTokens: 3, estimatedUsd: .03 } });
    event(db, 5, { type: "context_compacted", record: compaction("branch-compaction") });
    db.withdrawLatestSteering("run", "message");
    db.withdrawLatestRun("run");
    const archived = db.getSessionView("session")!.withdrawnEvents!;
    expect(archived.filter(item => item.type === "usage").reduce((total, item) => total + item.usage.inputTokens, 0)).toBe(130);
    expect(archived.filter(item => item.type === "context_compacted")).toHaveLength(1);
    expect(JSON.stringify(archived)).not.toContain("summary branch-compaction");
  });

  it("refuses legacy/active/completed/nonlatest messages and whole-run fallback", async () => {
    const { database: db } = await fixture();
    event(db, 1, { type: "steering_submitted", messageId: "legacy", text: "legacy" });
    expect(() => db.withdrawLatestSteering("run", "legacy")).toThrow("没有可恢复");
    expect(() => db.withdrawLatestRun("run")).toThrow("追加消息");
    db.updateRunStatus("run", "running");
    expect(() => db.prepareSteeringWithdrawal("run", "next", "checkpoint-run-0")).toThrow("已暂停");
    expect(() => db.withdrawLatestSteering("run", "legacy")).toThrow("已暂停");
    db.updateRunStatus("run", "completed");
    expect(() => db.withdrawLatestSteering("run", "legacy")).toThrow("已暂停");
    db.updateRunStatus("run", "paused");
    db.saveRun(run("newer", undefined, 10), "paused");
    expect(() => db.withdrawLatestSteering("run", "legacy")).toThrow("最新一轮");
  });

  it("rejects a stale checkpoint, live descendants and hidden sessions", async () => {
    const { database: db } = await fixture();
    expect(() => db.prepareSteeringWithdrawal("run", "message", "wrong-checkpoint")).toThrow("检查点已改变");
    db.saveRun(run("child", "run", 1), "running");
    expect(() => db.prepareSteeringWithdrawal("run", "message", "checkpoint-run-0")).toThrow("暂停完成");
    db.updateRunStatus("child", "paused");
    submit(db);
    db.updateRunStatus("child", "running");
    expect(() => db.withdrawLatestSteering("run", "message")).toThrow("暂停完成");
    db.updateRunStatus("child", "paused");
    db.deleteSession("session");
    expect(() => db.withdrawLatestSteering("run", "message")).toThrow("会话不存在");
  });

  it("rolls back a failed commit without losing the branch or its withdrawal boundary", async () => {
    const { database: db, crypto } = await fixture();
    submit(db);
    event(db, 2, { type: "usage", usage: { inputTokens: 10, outputTokens: 2, estimatedUsd: .01 } });
    const before = db.listEvents("run"), checkpointBefore = db.getLatestCheckpoint("run");
    const encrypt = crypto.encryptJson.bind(crypto);
    const failure = vi.spyOn(crypto, "encryptJson").mockImplementation((value, aad) => {
      if (aad?.startsWith("checkpoints:checkpoint_withdraw_")) throw new Error("fixture commit failed");
      return encrypt(value, aad);
    });
    expect(() => db.withdrawLatestSteering("run", "message")).toThrow("fixture commit failed");
    failure.mockRestore();
    expect(db.listEvents("run")).toEqual(before);
    expect(db.getLatestCheckpoint("run")).toEqual(checkpointBefore);
    expect(db.getSteeringWithdrawal("run")?.messageId).toBe("message");
    expect(db.getSessionView("session")?.withdrawnEvents).toEqual([]);
    expect(db.withdrawLatestSteering("run", "message").messageId).toBe("message");
  });

  it("keeps boundaries encrypted across restart and clears them and archived usage on purge", async () => {
    const state = await fixture();
    submit(state.database);
    const raw = new DatabaseSync(state.path);
    cleanup.push(async () => raw.close());
    expect(String(raw.prepare("SELECT payload FROM steering_withdrawals").get()?.payload)).not.toContain("暂停前上下文");
    const db = await state.reopen();
    expect(db.getSteeringWithdrawal("run")).toMatchObject({ runId: "run", messageId: "message", checkpointId: "checkpoint-run-0", beforeSequence: 0 });
    event(db, 2, { type: "usage", usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 } });
    db.withdrawLatestSteering("run", "message");
    submit(db, "next", db.getLatestCheckpoint("run")!.sequence + 1);
    db.deleteSession("session");
    db.purgeSession("session");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM steering_withdrawals").get()?.n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM withdrawn_message_events").get()?.n).toBe(0);
    expect(db.listCheckpoints("run")).toEqual([]);
  });
});
