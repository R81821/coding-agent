import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { descriptor, type ModelProvider } from "@harness/providers";
import { ToolRegistry } from "@harness/tools";
import { DEFAULT_PROFILE, nowIso, type RunCheckpoint, type RunSpec, type RunStatus, type TaskExecution } from "@harness/protocol";
import { reconcileTaskUsage } from "../packages/core/src/durable-recovery.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

type ChildUsage = NonNullable<TaskExecution["accountedUsage"]>;
const childUsage: ChildUsage = { inputTokens: 40, outputTokens: 20, estimatedUsd: 0.75, costKnown: true, turns: 3, toolCalls: 4 };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function checkpoint(run: RunSpec, sequence: number): RunCheckpoint {
  return {
    id: `checkpoint-${run.id}-${sequence}`, runId: run.id, sequence, reason: "manual", status: "paused", elapsedMs: 1234,
    transcript: [], usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: 1, costKnown: true }, turns: 5, toolCalls: 6,
    pendingNonIdempotentToolCalls: [], createdAt: nowIso(),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-durable-child-usage-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const vault = await VaultCrypto.open(join(root, "key.json"), "durable-child-usage-password");
  const databasePath = join(root, "state.sqlite");
  let database = await HarnessDatabase.open(databasePath, vault);
  cleanup.push(async () => {
    database.close(); vault.dispose();
    const path = relative(tmpdir(), root);
    if (!path || path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) throw new Error("Unsafe child usage fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const parent: RunSpec = {
    id: "parent-usage", sessionId: "session-usage", request: "Improve source with a child task", taskMode: "change", workspacePath: workspace,
    profileId: DEFAULT_PROFILE.id, budget: { ...DEFAULT_PROFILE.budget }, attachments: [], grants: [], createdAt: nowIso(),
  };
  const child: RunSpec = { ...parent, id: "child-usage", parentRunId: parent.id, parentStepId: "source-node" };
  const workflow = new SequentialWorkflow(parent.request, () => {});
  workflow.state.sequential!.taskExecutions = [{
    taskId: "source-task", stepId: child.parentStepId!, childRunId: child.id, mode: "write", status: "interrupted", startedAt: nowIso(),
  }];
  const savedParent: RunCheckpoint = { ...checkpoint(parent, 10), workflow: workflow.snapshot() };
  database.saveRun(parent, "paused"); database.saveRun(child, "completed"); database.saveCheckpoint(savedParent);
  let childSequence = 2;
  const saveChildUsage = (usage: ChildUsage = childUsage) => {
    const saved: RunCheckpoint = { ...checkpoint(child, childSequence++), usage: {
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUsd: usage.estimatedUsd,
      ...(usage.costKnown !== undefined ? { costKnown: usage.costKnown } : {}),
    }, turns: usage.turns, toolCalls: usage.toolCalls, elapsedMs: 55_000 };
    database.saveCheckpoint(saved);
  };
  saveChildUsage();
  return {
    root, parent, child, savedParent, saveChildUsage,
    get database() { return database; },
    parentCheckpoint() { return database.getLatestCheckpoint(parent.id)!; },
    async reopen() { database.close(); database = await HarnessDatabase.open(databasePath, vault); },
  };
}

function recordOf(checkpoint: RunCheckpoint): TaskExecution { return checkpoint.workflow!.sequential!.taskExecutions[0]!; }

describe("durable child usage accounting", { timeout: 20_000 }, () => {
  it.each(["start", "resume"] as const)("restores the reconciled child bill before allocating budgets through engine.%s", async action => {
    const f = await fixture(); await f.reopen();
    const model = descriptor({ providerId: "fake", modelId: "usage-restore", displayName: "Usage restore fixture" });
    const provider: ModelProvider = { id: "fake", listModels: async () => [model], health: async () => true, estimateCost: () => 0, async *stream() { yield { type: "text_delta", delta: "Remaining work is paused." }; } };
    const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database) });
    try {
      const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
      if (action === "start") engine.start(f.parent, profile, f.parentCheckpoint());
      else engine.resume(f.parent.id, profile);
      const budget = engine.childBudget(f.parent.id, 1);
      expect(budget.maxTurns).toBe(f.parent.budget.maxTurns - 8);
      expect(budget.maxToolCalls).toBe(f.parent.budget.maxToolCalls - 10);
      expect(budget.maxUsd).toBeCloseTo(f.parent.budget.maxUsd - 1.75);
    } finally { await engine.close(); }
  });

  it("recovers a missed child bill after database reopen and persists a receipt without changing duration or outcomes", async () => {
    const f = await fixture(); await f.reopen(); const parent = f.parentCheckpoint();
    const nodeBefore = JSON.stringify(parent.workflow); delete recordOf(parent).accountedUsage;
    expect(reconcileTaskUsage(parent, f.database)).toBe(true);
    expect(parent.usage).toEqual({ inputTokens: 140, outputTokens: 30, estimatedUsd: 1.75, costKnown: true });
    expect(parent.turns).toBe(8); expect(parent.toolCalls).toBe(10); expect(parent.elapsedMs).toBe(1234);
    expect(recordOf(parent).accountedUsage).toEqual(childUsage); expect(recordOf(parent).status).toBe("interrupted");
    const withoutReceipt = structuredClone(parent.workflow)!; delete withoutReceipt.sequential!.taskExecutions[0]!.accountedUsage;
    expect(JSON.stringify(withoutReceipt)).toBe(nodeBefore);
    expect(f.database.getRun(f.parent.id)?.status).toBe("paused"); expect(f.database.getRun(f.child.id)?.status).toBe("completed");
    expect(f.parentCheckpoint().usage.inputTokens).toBe(100); // The caller atomically saves the updated parent checkpoint.
    f.database.saveCheckpoint(parent); await f.reopen();
    expect(f.parentCheckpoint().usage.inputTokens).toBe(140); expect(recordOf(f.parentCheckpoint()).accountedUsage).toEqual(childUsage);
  });

  it("does not charge a previously accounted child again after a second process restart", async () => {
    const f = await fixture(); let parent = f.parentCheckpoint();
    expect(reconcileTaskUsage(parent, f.database)).toBe(true); f.database.saveCheckpoint(parent);
    await f.reopen(); parent = f.parentCheckpoint(); const before = JSON.stringify(parent);
    expect(reconcileTaskUsage(parent, f.database)).toBe(false); expect(JSON.stringify(parent)).toBe(before);
    expect(reconcileTaskUsage(parent, f.database)).toBe(false);
  });

  it("charges only additional real cumulative use from the same child after it is resumed", async () => {
    const f = await fixture(); let parent = f.parentCheckpoint(); reconcileTaskUsage(parent, f.database); f.database.saveCheckpoint(parent);
    const more: ChildUsage = { inputTokens: 75, outputTokens: 44, estimatedUsd: 1.3, costKnown: true, turns: 7, toolCalls: 10 };
    f.saveChildUsage(more); await f.reopen(); parent = f.parentCheckpoint();
    expect(reconcileTaskUsage(parent, f.database)).toBe(true);
    expect(parent.usage.inputTokens).toBe(175); expect(parent.usage.outputTokens).toBe(54); expect(parent.usage.estimatedUsd).toBeCloseTo(2.3);
    expect(parent.turns).toBe(12); expect(parent.toolCalls).toBe(16); expect(parent.elapsedMs).toBe(1234);
    expect(recordOf(parent).accountedUsage).toEqual(more);
    f.database.saveCheckpoint(parent); await f.reopen(); expect(reconcileTaskUsage(f.parentCheckpoint(), f.database)).toBe(false);
  });

  it.each(["parentRunId", "parentStepId"] as const)("rejects a child with a forged %s binding", async field => {
    const f = await fixture(); f.database.saveRun({ ...f.child, [field]: "unrelated" }, "completed");
    await f.reopen(); const parent = f.parentCheckpoint(); const before = JSON.stringify(parent);
    expect(reconcileTaskUsage(parent, f.database)).toBe(false); expect(JSON.stringify(parent)).toBe(before);
  });

  it("rejects missing child runs and runs without a durable usage checkpoint", async () => {
    const f = await fixture(); const parent = f.parentCheckpoint();
    recordOf(parent).childRunId = "missing-child";
    expect(reconcileTaskUsage(parent, f.database)).toBe(false); expect(recordOf(parent).accountedUsage).toBeUndefined();
    f.database.saveRun({ ...f.child, id: "missing-checkpoint" }, "failed"); recordOf(parent).childRunId = "missing-checkpoint";
    f.database.saveCheckpoint(parent); await f.reopen();
    expect(reconcileTaskUsage(f.parentCheckpoint(), f.database)).toBe(false); expect(f.parentCheckpoint().usage).toEqual(f.savedParent.usage);
  });

  it("does not charge active or queued children before their durable state has settled", async () => {
    const f = await fixture(); await f.reopen();
    for (const status of ["queued", "planning", "running", "waiting_approval", "verifying"] satisfies RunStatus[]) {
      f.database.updateRunStatus(f.child.id, status);
      const parent = f.parentCheckpoint(); const before = JSON.stringify(parent);
      expect(reconcileTaskUsage(parent, f.database), status).toBe(false); expect(JSON.stringify(parent), status).toBe(before);
      expect(f.database.getRun(f.child.id)?.status).toBe(status);
    }
  });

  it.each(["failed", "cancelled", "paused", "review"] satisfies RunStatus[])("still pays for real child use when the child stops as %s", async status => {
    const f = await fixture(); f.database.updateRunStatus(f.child.id, status); await f.reopen();
    const parent = f.parentCheckpoint(); expect(reconcileTaskUsage(parent, f.database)).toBe(true);
    expect(parent.usage.estimatedUsd).toBe(1.75); expect(parent.turns).toBe(8); expect(parent.toolCalls).toBe(10);
    expect(f.database.getRun(f.child.id)?.status).toBe(status); expect(recordOf(parent).status).toBe("interrupted");
  });

  it.each([false, undefined])("keeps cost knowledge conservative for child costKnown=%s", async known => {
    const f = await fixture(); const usage = { ...childUsage }; if (known === undefined) delete usage.costKnown; else usage.costKnown = known;
    f.saveChildUsage(usage); await f.reopen(); const parent = f.parentCheckpoint();
    expect(reconcileTaskUsage(parent, f.database)).toBe(true); expect(parent.usage.costKnown).toBe(false); expect(recordOf(parent).accountedUsage?.costKnown).toBe(false);
    expect(reconcileTaskUsage(parent, f.database)).toBe(false);
  });

  it("never upgrades unknown parent costs when a known child is accounted", async () => {
    const f = await fixture(); const parent = f.parentCheckpoint(); delete parent.usage.costKnown;
    reconcileTaskUsage(parent, f.database); expect(parent.usage.costKnown).toBe(false);
    expect(recordOf(parent).accountedUsage?.costKnown).toBe(true);
  });

  it("records actual overspend instead of clamping cost, tools or turns to the configured budget", async () => {
    const f = await fixture(); f.database.saveRun({ ...f.parent, budget: { ...f.parent.budget, maxUsd: 1.1, maxTurns: 6, maxToolCalls: 7 } }, "paused");
    await f.reopen(); const parent = f.parentCheckpoint(); expect(reconcileTaskUsage(parent, f.database)).toBe(true);
    const budget = f.database.getRun(f.parent.id)!.spec.budget;
    expect(parent.usage.estimatedUsd).toBeGreaterThan(budget.maxUsd); expect(parent.turns).toBeGreaterThan(budget.maxTurns); expect(parent.toolCalls).toBeGreaterThan(budget.maxToolCalls);
    expect(recordOf(parent).accountedUsage).toEqual(childUsage);
  });

  it("counts one authentic child once across duplicate task receipts and fills missing accounting markers", async () => {
    const f = await fixture(); const parent = f.parentCheckpoint(); const first = recordOf(parent);
    const partial: ChildUsage = { inputTokens: 20, outputTokens: 5, estimatedUsd: 0.2, costKnown: true, turns: 1, toolCalls: 2 };
    first.accountedUsage = partial;
    parent.usage.inputTokens += partial.inputTokens; parent.usage.outputTokens += partial.outputTokens; parent.usage.estimatedUsd += partial.estimatedUsd;
    parent.turns += partial.turns; parent.toolCalls += partial.toolCalls;
    const duplicate: TaskExecution = { ...first, taskId: "second-receipt" }; delete duplicate.accountedUsage;
    parent.workflow!.sequential!.taskExecutions.push(duplicate); f.database.saveCheckpoint(parent); await f.reopen();
    const saved = f.parentCheckpoint(); expect(reconcileTaskUsage(saved, f.database)).toBe(true);
    expect(saved.usage).toEqual({ inputTokens: 140, outputTokens: 30, estimatedUsd: 1.75, costKnown: true });
    expect(saved.turns).toBe(8); expect(saved.toolCalls).toBe(10);
    expect(saved.workflow?.sequential?.taskExecutions.map(record => record.accountedUsage)).toEqual([childUsage, childUsage]);
    expect(reconcileTaskUsage(saved, f.database)).toBe(false);
  });

  it("does not refund or re-charge already consumed use if a later child checkpoint regresses", async () => {
    const f = await fixture(); const parent = f.parentCheckpoint(); reconcileTaskUsage(parent, f.database); f.database.saveCheckpoint(parent);
    f.saveChildUsage({ inputTokens: 20, outputTokens: 10, estimatedUsd: 0.3, costKnown: true, turns: 1, toolCalls: 2 });
    await f.reopen(); const saved = f.parentCheckpoint(); const before = JSON.stringify(saved);
    expect(reconcileTaskUsage(saved, f.database)).toBe(false); expect(JSON.stringify(saved)).toBe(before);
    f.saveChildUsage(childUsage); expect(reconcileTaskUsage(saved, f.database)).toBe(false);
    f.saveChildUsage({ ...childUsage, inputTokens: 41, turns: 4 });
    expect(reconcileTaskUsage(saved, f.database)).toBe(true); expect(saved.usage.inputTokens).toBe(141); expect(saved.turns).toBe(9);
  });
});
