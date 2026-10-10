import { describe, expect, it, vi } from "vitest";
import { nowIso, type TaskExecution, type VerificationRun } from "@harness/protocol";
import type { ToolDefinition } from "@harness/tools";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const suite = (id: string) => ({ command: `node --test tests/${id}.test.mjs`, cwd: ".", timeoutMs: 1000 });
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `Implement ${id}`, verification: [suite(id)], ...extra });
const writer: ToolDefinition = {
  contract: { name: "apply_patch", description: "Apply a repository patch", inputSchema: {}, risk: "write", idempotent: false, timeoutMs: 1000 },
  async execute() { return { output: {} }; },
};
function setup(steps = [node("service"), node("caller")], extra: Record<string, unknown> = {}) {
  const publish = vi.fn();
  const workflow = new SequentialWorkflow("Implement service and caller", publish, undefined, {}, "change");
  workflow.observe({ id: "source", name: "read_file", input: { path: "service.ts" } }, { output: "export function service() { return 1; }" });
  workflow.advance({ action: "configure", summary: "Implement service and caller", requirements: ["Service works", "Caller stays compatible"],
    architecture: "service.ts owns service logic; caller.ts composes it", evidenceIds: ["source"], steps, integration: [suite("integration")], ...extra });
  publish.mockClear();
  return { workflow, publish };
}
function receipt(workflow: SequentialWorkflow): VerificationRun {
  return { id: "verify-local", runId: "parent", attempt: 0, stage: "local", epoch: workflow.state.epoch, revision: workflow.state.revision,
    passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(),
    results: workflow.plannedChecks().filter(item => item.stage === "local").map(item => ({ itemId: item.id, command: item.command, cwd: item.cwd,
      passed: true, required: true, exitCode: 0, timedOut: false, durationMs: 1, output: "Tests passed" })),
  };
}
function execution(workflow: SequentialWorkflow, stepId: string): TaskExecution {
  const record = workflow.snapshot().sequential!.taskExecutions.find(item => item.stepId === stepId);
  if (!record) throw new Error("Test task has not been dispatched");
  return record;
}
const executable = (id: string, extra: Record<string, unknown> = {}) => node(id, {
  execution: { mode: "write", prompt: `Implement ${id} in its own node`, writePaths: [`${id}.ts`] }, ...extra,
});

describe("task graph next-step selection", () => {
  it("prefers explicit priority over a longer dependency chain", () => {
    const { workflow } = setup([
      node("chain"), node("chain-middle", { dependsOn: ["chain"] }), node("chain-end", { dependsOn: ["chain-middle"] }),
      node("urgent", { priority: 10 }),
    ]);
    expect(workflow.availableTaskSteps().map(item => item.id)).toEqual(["urgent", "chain"]);
    workflow.advance({ action: "select_next" });
    expect(workflow.state.sequential?.activeStepId).toBe("urgent");
  });

  it("uses downstream critical path when eligible priorities are equal", () => {
    const { workflow } = setup([
      node("short", { priority: 5 }), node("chain", { priority: 5 }),
      node("chain-middle", { dependsOn: ["chain"] }), node("chain-end", { dependsOn: ["chain-middle"] }),
    ]);
    workflow.advance({ action: "select_next" });
    expect(workflow.state.sequential?.activeStepId).toBe("chain");
  });

  it("allows the model to choose any eligible independent node explicitly", () => {
    const { workflow } = setup([node("urgent", { priority: 100 }), node("low", { priority: 1 }), node("dependent", { dependsOn: ["urgent"] })]);
    workflow.advance({ action: "select_next", stepId: "low", reason: "Complete a small independent fix first" });
    expect(workflow.state.sequential?.activeStepId).toBe("low");
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "select_next", stepId: "dependent" })).toThrow(/eligible/);
    expect(workflow.snapshot()).toEqual(before);
  });

  it("unlocks a successor only after real prerequisite test receipts", () => {
    const { workflow } = setup([node("service"), node("caller", { dependsOn: ["service"] })]);
    workflow.advance({ action: "select_next" });
    expect(() => workflow.advance({ action: "select_next", stepId: "caller" })).toThrow(/eligible/);
    workflow.recordVerification(receipt(workflow));
    workflow.advance({ action: "select_next" });
    expect(workflow.state.sequential?.activeStepId).toBe("caller");
  });

  it.each(["manual", "autonomous"] as const)("does not select a node just to read source with %s policy", selectionPolicy => {
    const { workflow } = setup(undefined, { selectionPolicy });
    const reader: ToolDefinition = { ...writer, contract: { ...writer.contract, name: "read_file", risk: "read", idempotent: true } };
    expect(workflow.before({ id: "read-more", name: "read_file", input: { path: "caller.ts" } }, reader)).toBeUndefined();
    expect(workflow.state.sequential?.activeStepId).toBe("");
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["pending", "pending"]);
  });

  it("requires explicit selection for an adaptive manual plan", () => {
    const { workflow } = setup(undefined, { selectionPolicy: "manual" });
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "planned edit" } }, writer)).toContain("workflow_step_required");
    expect(workflow.state.sequential?.activeStepId).toBe("");
    workflow.advance({ action: "select_next", stepId: "caller" });
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "planned edit" } }, writer)).toBeUndefined();
  });

  it("keeps ordered plans manual and does not auto-start writes", () => {
    const { workflow } = setup(undefined, { mode: "ordered" });
    expect(workflow.state.sequential?.selectionPolicy).toBe("manual");
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "planned edit" } }, writer)).toContain("workflow_step_required");
    expect(() => workflow.advance({ action: "select_next", stepId: "caller" })).toThrow(/eligible/);
    expect(workflow.state.sequential?.activeStepId).toBe("");
  });

  it("automatically selects an eligible node when an authorized write needs an active step", () => {
    const { workflow } = setup([node("service"), node("caller", { priority: 10 })]);
    expect(workflow.state.sequential?.selectionPolicy).toBe("autonomous");
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "planned edit" } }, writer)).toBeUndefined();
    expect(workflow.state.sequential?.activeStepId).toBe("caller");
    expect(workflow.state.sequential?.steps.find(item => item.id === "service")?.status).toBe("pending");
  });

  it("keeps an explicit in-progress selection instead of overriding it by priority", () => {
    const { workflow } = setup([node("service"), node("caller", { priority: 100 })]);
    workflow.advance({ action: "select_next", stepId: "service" });
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "planned edit" } }, writer)).toBeUndefined();
    expect(workflow.state.sequential?.activeStepId).toBe("service");
  });

  it("can continue with the next eligible node after the active step is verified", () => {
    const { workflow } = setup([node("service"), node("caller", { dependsOn: ["service"] })]);
    workflow.advance({ action: "select_next" });
    workflow.recordVerification(receipt(workflow));
    expect(workflow.before({ id: "patch", name: "apply_patch", input: { patch: "caller edit" } }, writer)).toBeUndefined();
    expect(workflow.state.sequential?.activeStepId).toBe("caller");
    expect(workflow.state.sequential?.steps[0]?.status).toBe("verified");
  });

  it("excludes running child nodes from next-step candidates", () => {
    const { workflow } = setup([executable("service", { priority: 100 }), executable("caller")]);
    workflow.beginTasks(["service"]);
    expect(workflow.availableTaskSteps().map(item => item.id)).toEqual(["caller"]);
    expect(() => workflow.advance({ action: "select_next", stepId: "service" })).toThrow(/eligible/);
    workflow.advance({ action: "select_next" });
    expect(workflow.state.sequential?.activeStepId).toBe("caller");
  });
});

describe("task graph plan updates preserve running work and evidence", () => {
  it.each([
    { name: "remove the node", update: { removeStepIds: ["service"] } },
    { name: "rename the running responsibility", update: { steps: [node("service", { text: "Change running responsibility" })] } },
    { name: "replace its test suite", update: { steps: [node("service", { verification: [suite("other-service")] })] } },
    { name: "change execution mode", update: { steps: [executable("service", { execution: { mode: "read" } })] } },
    { name: "change priority", update: { steps: [node("service", { priority: 100 })] } },
    { name: "add a dependency", update: { steps: [node("service", { dependsOn: ["caller"] })] } },
  ])("rejects a plan update that would $name atomically", ({ update }) => {
    const { workflow, publish } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service"]);
    publish.mockClear();
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "update_plan", reason: "Adjust scheduling", ...update })).toThrow(/running graph tasks/);
    expect(workflow.snapshot()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("validates a reconfigure before overwriting understanding, architecture or evidence", () => {
    const { workflow, publish } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service"]);
    workflow.observe({ id: "new-source", name: "read_file", input: { path: "caller.ts" } }, { output: "export const caller = 1;" });
    publish.mockClear();
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "configure", summary: "Replacement understanding", requirements: [...workflow.state.requirements],
      architecture: "Replacement architecture", evidenceIds: ["new-source"], reason: "Replace running graph", steps: [executable("caller")], integration: [suite("replacement-integration")] })).toThrow(/running graph tasks/);
    expect(workflow.snapshot()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains omitted scheduling metadata and dependencies in a same-ID text upsert", () => {
    const { workflow } = setup([node("service"), executable("caller", { dependsOn: ["service"], priority: 31 })]);
    const before = workflow.snapshot().sequential!.steps.find(item => item.id === "caller")!;
    workflow.advance({ action: "update_plan", reason: "Clarify the caller contract", steps: [node("caller", { text: "Keep the caller API compatible" })] });
    const after = workflow.snapshot().sequential!.steps.find(item => item.id === "caller")!;
    expect(after).toMatchObject({ priority: 31, execution: before.execution, dependsOn: ["service"], verificationKey: before.verificationKey });
    expect(after.check).toEqual(before.check);
  });

  it("allows replanning an independent node while another child is running", () => {
    const { workflow } = setup([executable("service", { priority: 25 }), executable("caller")]);
    workflow.beginTasks(["service"]);
    const task = execution(workflow, "service");
    workflow.advance({ action: "update_plan", reason: "Narrow the independent caller implementation", steps: [node("caller", { text: "Handle the caller edge case", priority: 40 })] });
    expect(execution(workflow, "service")).toEqual(task);
    expect(workflow.state.sequential?.steps.find(item => item.id === "service")?.priority).toBe(25);
    expect(workflow.state.sequential?.steps.find(item => item.id === "caller")?.priority).toBe(40);
  });
});

describe("task execution identity and parent verification", () => {
  it.each([
    { name: "unknown task", patch: { taskId: "not-dispatched" } },
    { name: "another step", patch: { stepId: "caller" } },
    { name: "another execution mode", patch: { mode: "read" as const } },
  ])("rejects a task receipt for $name without changing graph state", ({ patch }) => {
    const { workflow, publish } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service"]);
    publish.mockClear();
    const task = execution(workflow, "service"), before = workflow.snapshot();
    expect(() => workflow.recordTask({ ...task, ...patch })).toThrow(/dispatched|identity/);
    expect(workflow.snapshot()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("binds a dispatched task to one child run and rejects replacing or removing it", () => {
    const { workflow } = setup([executable("service")]);
    workflow.beginTasks(["service"]);
    const task = execution(workflow, "service");
    workflow.recordTask({ ...task, childRunId: "child-one" });
    const bound = execution(workflow, "service"), before = workflow.snapshot();
    expect(() => workflow.recordTask({ ...bound, childRunId: "child-two", status: "completed" })).toThrow(/identity/);
    expect(() => workflow.recordTask({ ...task, status: "completed" })).toThrow(/identity/);
    expect(workflow.snapshot()).toEqual(before);
    workflow.recordTask({ ...bound, status: "completed", finishedAt: nowIso(), summary: "Child completed its isolated patch" });
    expect(execution(workflow, "service").status).toBe("completed");
    expect(workflow.state.sequential?.steps[0]?.status).toBe("in_progress");
    expect(workflow.state.sequential?.steps[0]?.check.status).toBe("pending");
    expect(workflow.canFinish()).toBe(false);
  });

  it.each(["completed", "failed", "interrupted"] as const)("does not overwrite or replay a settled %s child record", status => {
    const { workflow } = setup([executable("service")]);
    workflow.beginTasks(["service"]);
    workflow.recordTask({ ...execution(workflow, "service"), status, finishedAt: nowIso() });
    const before = workflow.snapshot();
    expect(() => workflow.recordTask({ ...execution(workflow, "service"), status: "running" })).toThrow(/settled|Settled/);
    expect(() => workflow.recordTask({ ...execution(workflow, "service"), status: "completed" })).toThrow(/settled|Settled/);
    expect(workflow.snapshot()).toEqual(before);
  });

  it("does not automatically redispatch a completed child", () => {
    const { workflow } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service"]);
    workflow.recordTask({ ...execution(workflow, "service"), status: "completed", finishedAt: nowIso() });
    expect(workflow.beginTasks().map(task => task.stepId)).toEqual(["caller"]);
    expect(execution(workflow, "service").status).toBe("completed");
  });

  it("requires an explicit reason to retry interrupted work with a new task identity", () => {
    const { workflow } = setup([executable("service")]);
    workflow.beginTasks(["service"]);
    const old = execution(workflow, "service");
    workflow.recordTask({ ...old, status: "interrupted", finishedAt: nowIso(), patch: "saved incremental patch" });
    const before = workflow.snapshot();
    expect(() => workflow.beginTasks()).toThrow(/eligible/);
    expect(() => workflow.beginTasks(["service"])).toThrow(/retry reason/);
    expect(workflow.snapshot()).toEqual(before);
    const [retry] = workflow.beginTasks(["service"], "Inspected the saved patch; safely rerun this isolated implementation");
    expect(retry!.id).not.toBe(old.taskId);
    expect(execution(workflow, "service").status).toBe("running");
  });

  it("rejects parent verification while a child is still running", () => {
    const { workflow } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service", "caller"]);
    expect(workflow.verificationGate("local")).toMatch(/running graph tasks/);
    expect(workflow.verificationGate("broader")).toMatch(/running graph tasks/);
    workflow.recordVerification(receipt(workflow));
    expect(workflow.state.localCheck.status).not.toBe("passed");
    expect(workflow.state.sequential?.steps.every(item => item.status !== "verified")).toBe(true);
    expect(workflow.checksCurrent()).toBe(false);
  });

  it("requires parent suites after settled children before marking their nodes verified", () => {
    const { workflow } = setup([executable("service"), executable("caller")]);
    workflow.beginTasks(["service", "caller"]);
    for (const id of ["service", "caller"]) workflow.recordTask({ ...execution(workflow, id), status: "completed", finishedAt: nowIso() });
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["in_progress", "in_progress"]);
    workflow.recordVerification(receipt(workflow));
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["verified", "verified"]);
    expect(workflow.canFinish()).toBe(false);
  });

  it("keeps large patches out of the projection while retaining durable artifacts", () => {
    const longPatch = "sensitive-incremental-patch:" + "p".repeat(100_000);
    const prompt = "p".repeat(10_000);
    const summary = "s".repeat(6000);
    const { workflow } = setup([executable("service", { execution: { mode: "write", prompt, writePaths: ["service.ts"] } })]);
    workflow.beginTasks(["service"]);
    workflow.recordTask({ ...execution(workflow, "service"), status: "completed", finishedAt: nowIso(), patch: longPatch, summary });
    const projected = workflow.projection().sequential as { taskExecutions: Array<{ hasPatch: boolean; patch?: unknown; summary?: string }>; steps: Array<{ execution: { prompt?: string } }> };
    expect(projected.taskExecutions[0]).toMatchObject({ hasPatch: true });
    expect(projected.taskExecutions[0]).not.toHaveProperty("patch");
    expect(projected.taskExecutions[0]!.summary!.length).toBeLessThanOrEqual(600);
    expect(projected.steps[0]!.execution.prompt!.length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(workflow.projection())).not.toContain("sensitive-incremental-patch:");
    expect(execution(workflow, "service").patch).toBe(longPatch);
  });
});
