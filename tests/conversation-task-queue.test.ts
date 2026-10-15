import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { ConversationTaskUsageSchema, DEFAULT_PROFILE, WorkflowStateSchema, type ConversationTaskInput, type RunCheckpoint } from "@harness/protocol";

const at = "2026-10-15T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function task(taskId: string, patch: Partial<ConversationTaskInput> = {}): ConversationTaskInput {
  return { taskId, sessionId: "session", parentRunId: "run", stepId: taskId, planGeneration: 0, source: { kind: "run" },
    prompt: `secret task ${taskId}`, mode: "read", createdAt: at, updatedAt: at, ...patch };
}
function checkpoint(sequence = 0): RunCheckpoint {
  return { id: `cp-${sequence}`, runId: "run", sequence, reason: "manual", status: "paused", transcript: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }, turns: 0, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: at,
    workflow: WorkflowStateSchema.parse({ phase: "small_edit", objective: "fixture", requirements: [], context: "", plan: [], hypotheses: [], observations: [], relevantFiles: [], changedFiles: [], revision: 0, localRevision: 0, broaderRevision: 0, diffRevision: 0, requirementsRevision: 0, reviewedRevision: 0, failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "", sequential: { generation: 0 } }) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-conversation-queue-")), path = join(root, "data.sqlite");
  const crypto = await VaultCrypto.open(join(root, "key.json"), "fixture-passphrase");
  let database = await HarnessDatabase.open(path, crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  database.createSession({ id: "session", title: "fixture", workspacePath: root, profileId: "default", createdAt: at, updatedAt: at });
  database.saveRun({ id: "run", sessionId: "session", request: "fixture", workspacePath: root, profileId: "default", budget: DEFAULT_PROFILE.budget, grants: [], attachments: [], createdAt: at }, "paused");
  database.saveCheckpoint(checkpoint());
  return { get database() { return database; }, path, async reopen() { database.close(); database = await HarnessDatabase.open(path, crypto); return database; } };
}
const limit = { maxTurns: 10, maxToolCalls: 10, maxDurationMs: 1000, maxUsd: 1 };
const reservation = { maxTurns: 6, maxToolCalls: 6, maxDurationMs: 600, maxUsd: .6 };

describe("durable conversation task queue", () => {
  it("deduplicates submissions and persists queue provenance without inventing a start", async () => {
    const state = await fixture(), db = state.database;
    db.appendEvent({ id: "steering-source", runId: "run", sequence: 1, at, type: "steering_submitted", messageId: "secret-message", text: "fixture" });
    const [first] = db.enqueueConversationTasks([task("a", { source: { kind: "steering", messageId: "secret-message", checkpointId: "cp-0" }, dependsOn: ["plan-step"] })]);
    const [again] = db.enqueueConversationTasks([task("different-id", { stepId: "a", source: first!.source, dependsOn: ["plan-step"] , prompt: first!.prompt })]);
    expect(again!.taskId).toBe("a"); expect(db.listConversationTasks("run")).toHaveLength(1);
    expect(first).toMatchObject({ executionState: "queued", attempts: [], dependsOn: ["plan-step"] }); expect(first!.startedAt).toBeUndefined();
    expect((await state.reopen()).getConversationTask("a")).toEqual(first);
    const raw = new DatabaseSync(state.path, { readOnly: true });
    try { const row = raw.prepare("SELECT * FROM conversation_tasks").get()!; expect(JSON.stringify(row)).not.toContain("secret"); expect(row.execution_state).toBe("queued"); } finally { raw.close(); }
  });

  it("rejects cycles, conflicting duplicates and oversized batches atomically", async () => {
    const { database: db } = await fixture();
    expect(() => db.enqueueConversationTasks([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })])).toThrow("cycle");
    expect(db.listConversationTasks("run")).toEqual([]);
    expect(() => db.enqueueConversationTasks([task("same", { stepId: "a" }), task("same", { stepId: "b" })])).toThrow("identity");
    expect(() => db.enqueueConversationTasks([task("a"), task("b")], { maxQueueLength: 1 })).toThrow("limit");
    expect(db.listConversationTasks("run")).toEqual([]);
    db.enqueueConversationTasks([task("a")]);
    expect(() => db.enqueueConversationTasks([task("different", { stepId: "a", prompt: "changed" })])).toThrow("Conflicting");
  });

  it("claims once, fixes attempt identity before start, and rejects illegal or stale transitions", async () => {
    const { database: db } = await fixture(); db.enqueueConversationTasks([task("a")]);
    expect(() => db.updateConversationTask("a", { executionState: "running" })).toThrow("claimed");
    const claimed = db.claimConversationTask("a", { attemptId: "attempt-1", childRunId: "child-1" })!;
    expect(claimed).toMatchObject({ executionState: "running", attemptId: "attempt-1", childRunId: "child-1", attempts: [{ claimedAt: expect.any(String) }] });
    expect(claimed.startedAt).toBeUndefined(); expect(db.claimConversationTask("a")).toBeUndefined();
    expect(() => db.updateConversationTask("a", { executionState: "completed" })).toThrow("attempt identity");
    expect(() => db.updateConversationTask("a", { executionState: "completed" }, { expectedAttemptId: "old" })).toThrow("Stale");
    db.updateConversationTask("a", { executionState: "awaiting_integration", summary: "ready", startedAt: at }, { expectedAttemptId: "attempt-1" });
    expect(db.updateConversationTask("a", { executionState: "completed" }, { expectedAttemptId: "attempt-1" }).acceptanceState).toBe("pending");
    expect(() => db.updateConversationTask("a", { executionState: "queued", retryReason: "try again" })).toThrow("Invalid");
  });

  it("commits queue, projected checkpoint and events together and rolls all back on a conflict", async () => {
    const { database: db } = await fixture();
    db.enqueueConversationTasks([task("a")], { checkpoint: checkpoint(1), events: [{ id: "event-1", runId: "run", sequence: 1, at, type: "text_delta", delta: "accepted" }] });
    expect(db.getLatestCheckpoint("run")).toMatchObject({ conversationTaskQueue: { taskIds: ["a"], version: 1 }, workflow: { sequential: { taskExecutions: [{ taskId: "a", status: "queued" }] } } });
    const claimed = db.claimConversationTask("a")!;
    expect(() => db.updateConversationTask("a", { executionState: "completed" }, { expectedAttemptId: claimed.attemptId!, checkpoint: checkpoint(2), events: [{ id: "conflict", runId: "other-run", sequence: 1, at, type: "text_delta", delta: "bad" }] })).toThrow();
    expect(db.getConversationTask("a")!.executionState).toBe("running"); expect(db.getLatestCheckpoint("run")!.id).toBe("cp-1");
    expect(db.listEvents("run")).toHaveLength(1);
  });

  it("reserves shared budget atomically, settles monotonically, and retains old attempts on explicit retry", async () => {
    const { database: db } = await fixture(); db.enqueueConversationTasks([task("a"), task("b")]);
    const first = db.claimConversationTask("a", { budgetLimit: limit, budgetReservation: reservation })!;
    expect(() => db.claimConversationTask("b", { budgetLimit: limit, budgetReservation: reservation })).toThrow("budget exhausted");
    db.updateConversationTask("a", { executionState: "failed", accountedUsage: { estimatedUsd: .2, turns: 2 } }, { expectedAttemptId: first.attemptId! });
    expect(() => db.updateConversationTask("a", { executionState: "queued" })).toThrow("reason");
    db.updateConversationTask("a", { executionState: "queued", retryReason: "read-only failure inspected" });
    const retry = db.claimConversationTask("a", { budgetLimit: limit, budgetReservation: reservation, accountedUsage: ConversationTaskUsageSchema.parse({ estimatedUsd: .2, turns: 2 }) })!;
    expect(retry.attemptId).not.toBe(first.attemptId); expect(retry.attempts).toHaveLength(2);
    expect(retry.attempts[0]).toMatchObject({ reservationState: "settled", accountedUsage: { estimatedUsd: .2, turns: 2 } });
    expect(() => db.updateConversationTask("a", { executionState: "completed" }, { expectedAttemptId: first.attemptId! })).toThrow("Stale");
    db.updateConversationTask("a", { accountedUsage: { estimatedUsd: .3 } }, { expectedAttemptId: retry.attemptId! });
    db.updateConversationTask("a", { accountedUsage: { estimatedUsd: .1 } }, { expectedAttemptId: retry.attemptId! });
    expect(db.getConversationTask("a")!.attempts[1]!.accountedUsage.estimatedUsd).toBe(.3);
  });

  it("restart interrupts unknown running attempts, preserves queued and completed tasks, and releases reservations", async () => {
    const state = await fixture(), db = state.database; db.enqueueConversationTasks([task("a"), task("b"), task("c")]);
    db.claimConversationTask("a", { budgetLimit: limit, budgetReservation: reservation });
    const done = db.claimConversationTask("c")!; db.updateConversationTask("c", { executionState: "completed" }, { expectedAttemptId: done.attemptId! });
    const recovered = await state.reopen();
    expect(recovered.getConversationTask("a")).toMatchObject({ executionState: "interrupted", attempts: [{ reservationState: "released" }] });
    expect(recovered.getConversationTask("b")!.executionState).toBe("queued"); expect(recovered.getConversationTask("c")!.executionState).toBe("completed");
    expect(recovered.claimConversationTask("a")).toBeUndefined();
  });

  it("withdrawal restores its exact queue branch and retains spent attempt watermarks", async () => {
    const { database: db } = await fixture(); db.enqueueConversationTasks([task("old")]);
    const old = db.claimConversationTask("old")!;
    db.updateConversationTask("old", { executionState: "interrupted", accountedUsage: { inputTokens: 10, estimatedUsd: .1 } }, { expectedAttemptId: old.attemptId! });
    db.saveCheckpoint(checkpoint(1)); db.prepareSteeringWithdrawal("run", "message", "cp-1");
    db.appendEvent({ id: "message", runId: "run", sequence: 2, at, type: "steering_submitted", messageId: "message", text: "steer" });
    db.enqueueConversationTasks([task("new", { planGeneration: 1, source: { kind: "steering", messageId: "message" } })]);
    db.updateConversationTask("old", { executionState: "queued", retryReason: "inspected" }); const retry = db.claimConversationTask("old")!;
    db.updateConversationTask("old", { executionState: "interrupted", accountedUsage: { inputTokens: 20, estimatedUsd: .2 } }, { expectedAttemptId: retry.attemptId! });
    db.saveCheckpoint(checkpoint(3)); db.withdrawLatestSteering("run", "message");
    expect(db.listConversationTasks("run").map(item => item.taskId)).toEqual(["old"]);
    const restored = db.getConversationTask("old")!; expect(restored.executionState).toBe("interrupted"); expect(restored.attemptId).toBe(old.attemptId);
    expect(restored.attempts.map(attempt => attempt.accountedUsage.inputTokens)).toEqual([10, 20]);
    expect(db.getConversationTask("new")).toBeUndefined(); expect(() => db.updateConversationTask("new", { executionState: "completed" })).toThrow("withdrawn");
    expect(() => db.enqueueConversationTasks([task("late", { source: { kind: "steering", messageId: "message" } })])).toThrow("withdrawn");
    expect(db.getLatestCheckpoint("run")!.conversationTaskQueue!.taskIds).toEqual(["old"]);
  });

  it("accounts historical and withdrawn attempts atomically without reviving their result or changing terminal time", async () => {
    const { database: db } = await fixture(); db.enqueueConversationTasks([task("history")]); const first = db.claimConversationTask("history")!;
    db.updateConversationTask("history", { executionState: "failed", finishedAt: at, summary: "immutable first result", accountedUsage: { inputTokens: 10, estimatedUsd: .1, costKnown: false } }, { expectedAttemptId: first.attemptId! });
    db.updateConversationTask("history", { executionState: "queued", retryReason: "safe inspected retry" }); const second = db.claimConversationTask("history")!;
    const done = db.updateConversationTask("history", { executionState: "completed", finishedAt: at, summary: "current result" }, { expectedAttemptId: second.attemptId! });
    db.updateConversationTask("history", { accountedUsage: { inputTokens: 20 } }, { expectedAttemptId: second.attemptId! });
    expect(db.getConversationTask("history")!.finishedAt).toBe(done.finishedAt);
    const baseline = { ...checkpoint(1), usage: { inputTokens: 30, outputTokens: 0, estimatedUsd: .1 } };
    db.saveCheckpoint(baseline);
    expect(() => db.accountConversationTaskAttempt("history", first.attemptId!, { inputTokens: 40, estimatedUsd: .4 }, {
      checkpoint: baseline, applyUsageToCheckpoint: true, events: [{ id: "wrong-parent", runId: "another-parent", sequence: 9, at, type: "text_delta", delta: "invalid transaction" }],
    })).toThrow("another parent");
    expect(baseline.usage.inputTokens).toBe(30); expect(db.getConversationTask("history")!.attempts[0]!.accountedUsage.inputTokens).toBe(10);
    expect(db.getLatestCheckpoint("run")!.usage.inputTokens).toBe(30);
    const accounted = db.accountConversationTaskAttempt("history", first.attemptId!, { inputTokens: 40, estimatedUsd: .4, costKnown: true }, { checkpoint: baseline, applyUsageToCheckpoint: true });
    expect(accounted.delta).toMatchObject({ inputTokens: 30, costKnown: false }); expect(accounted.delta.estimatedUsd).toBeCloseTo(.3);
    expect(accounted.checkpoint!.usage.inputTokens).toBe(60); expect(accounted.task).toMatchObject({ executionState: "completed", summary: "current result", finishedAt: at });
    const again = db.accountConversationTaskAttempt("history", first.attemptId!, { inputTokens: 40, estimatedUsd: .4 }, { checkpoint: accounted.checkpoint!, applyUsageToCheckpoint: true });
    expect(again.delta.inputTokens).toBe(0); expect(again.checkpoint!.usage).toEqual(accounted.checkpoint!.usage);
    db.saveCheckpoint({ ...again.checkpoint!, id: "withdraw-boundary", sequence: 2 }); db.prepareSteeringWithdrawal("run", "branch", "withdraw-boundary");
    db.appendEvent({ id: "branch-message", runId: "run", sequence: 3, at, type: "steering_submitted", messageId: "branch", text: "branch" });
    db.enqueueConversationTasks([task("withdrawn", { planGeneration: 1, source: { kind: "steering", messageId: "branch" } })]); const branch = db.claimConversationTask("withdrawn")!;
    db.updateConversationTask("withdrawn", { executionState: "interrupted" }, { expectedAttemptId: branch.attemptId! }); db.withdrawLatestSteering("run", "branch");
    const audited = db.accountConversationTaskAttempt("withdrawn", branch.attemptId!, { inputTokens: 8, estimatedUsd: .08 }, { checkpoint: db.getLatestCheckpoint("run")!, applyUsageToCheckpoint: true });
    expect(audited.task).toMatchObject({ executionState: "cancelled", withdrawnAt: expect.any(String) }); expect(db.getConversationTask("withdrawn")).toBeUndefined();
    expect(db.getLatestCheckpoint("run")!.usage.inputTokens).toBe(68);
  });

  it("does not automatically replay a previously queued task that actually started after a withdrawn message", async () => {
    const { database: db } = await fixture();
    db.enqueueConversationTasks([task("previously-queued")]);
    db.saveCheckpoint(checkpoint(1)); db.prepareSteeringWithdrawal("run", "message", "cp-1");
    db.appendEvent({ id: "message", runId: "run", sequence: 2, at, type: "steering_submitted", messageId: "message", text: "steer" });
    const claimed = db.claimConversationTask("previously-queued")!;
    db.updateConversationTask("previously-queued", { executionState: "interrupted", accountedUsage: { inputTokens: 9 } }, { expectedAttemptId: claimed.attemptId! });
    db.saveCheckpoint(checkpoint(3)); db.withdrawLatestSteering("run", "message");
    expect(db.getConversationTask("previously-queued")).toMatchObject({ executionState: "interrupted", attempts: [{ accountedUsage: { inputTokens: 9 } }] });
    expect(db.claimConversationTask("previously-queued")).toBeUndefined();
    expect(() => db.updateConversationTask("previously-queued", { executionState: "queued" })).toThrow("explicit reason");
  });
});
