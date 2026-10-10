import { describe, expect, it, vi } from "vitest";
import { SequentialWorkflowSchema } from "@harness/protocol";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { todoTool } from "../packages/core/src/runtime-tools.js";
import { synchronizeWorkflowTodos } from "../packages/core/src/workflow-tasks.js";

const context = { runId: "run", workspacePath: ".", grants: [], signal: new AbortController().signal };
const verification = [{ command: "node --test tests/service.test.mjs", cwd: ".", timeoutMs: 1000 }];
function setup() {
  const publish = vi.fn();
  const workflow = new LightweightWorkflow("Improve service", publish, undefined, {}, "change");
  return { workflow, publish, tool: todoTool(workflow) };
}
function plan(workflow: LightweightWorkflow, ids = ["service", "caller"]) {
  workflow.state.sequential = SequentialWorkflowSchema.parse({ steps: ids.map(id => ({ id, text: `Implement ${id}`, verification })) });
}

describe("runtime-owned plan todos and manual task updates", () => {
  it("queries without publishing or changing phase, including synchronization of recovered old todo rows", async () => {
    const { workflow, publish, tool } = setup();
    plan(workflow);
    workflow.state.todos = [
      { id: "old", stepId: "old", text: "Old plan", status: "completed" },
      { id: "manual", text: "Inspect caller", status: "pending" },
    ];
    const phase = workflow.state.phase;
    const result = await tool.execute({}, context);
    expect(publish).not.toHaveBeenCalled();
    expect(workflow.state.phase).toBe(phase);
    expect(result).toMatchObject({ output: { count: 3, changed: false, manualCount: 1, items: workflow.state.todos } });
    expect(workflow.state.todos?.map(item => item.id)).toEqual(["service", "caller", "manual"]);
    expect(workflow.state.todos?.[0]).toMatchObject({ stepId: "service", status: "pending" });
  });

  it("publishes once for changed manual tasks and ignores identical updates or empty updates", async () => {
    const { publish, tool } = setup();
    const item = { id: "inspect", text: "Inspect caller", status: "pending" };
    expect(await tool.execute({ items: [item] }, context)).toMatchObject({ output: { count: 1, changed: true } });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await tool.execute({ items: [item] }, context)).toMatchObject({ output: { changed: false } });
    await tool.execute({ items: [] }, context);
    await tool.execute({}, context);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await tool.execute({ items: [{ ...item, status: "cancelled" }] }, context)).toMatchObject({ output: { count: 1, changed: true } });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].todos).toEqual([{ ...item, status: "cancelled" }]);
  });

  it("projects step progress and bounds text without treating in-progress implementation as verified", () => {
    const { workflow } = setup();
    plan(workflow, ["pending", "active", "passed"]);
    const steps = workflow.state.sequential!.steps;
    steps[1]!.status = "in_progress";
    steps[2]!.status = "verified";
    steps[2]!.text = "Completed test-backed work ".repeat(20);
    synchronizeWorkflowTodos(workflow.state);
    expect(workflow.state.todos?.map(item => item.status)).toEqual(["pending", "in_progress", "completed"]);
    expect(workflow.state.todos?.every(item => item.id === item.stepId)).toBe(true);
    expect(workflow.state.todos?.[2]?.text).toHaveLength(300);
    expect(workflow.canFinish()).toBe(false);
  });

  it("removes linked rows when replanning while preserving manual work and overriding colliding manual IDs", () => {
    const { workflow } = setup();
    plan(workflow, ["service"]);
    workflow.state.todos = [
      { id: "service", text: "Manual duplicate", status: "completed" },
      { id: "manual", text: "Inspect caller", status: "in_progress" },
    ];
    synchronizeWorkflowTodos(workflow.state);
    expect(workflow.state.todos).toEqual([
      { id: "service", stepId: "service", text: "Implement service", status: "pending" },
      { id: "manual", text: "Inspect caller", status: "in_progress" },
    ]);
    plan(workflow, ["replacement"]);
    synchronizeWorkflowTodos(workflow.state);
    expect(workflow.state.todos?.map(item => item.id)).toEqual(["replacement", "manual"]);
    workflow.state.sequential = undefined;
    synchronizeWorkflowTodos(workflow.state);
    expect(workflow.state.todos).toEqual([{ id: "manual", text: "Inspect caller", status: "in_progress" }]);
  });

  it.each([
    { text: "Implement service", status: "completed" },
    { text: "Implement service", status: "in_progress" },
    { text: "Change plan text", status: "pending" },
  ])("rejects fabricated step progress or text atomically: %j", async update => {
    const { workflow, publish, tool } = setup();
    plan(workflow, ["service"]);
    // The malformed batch must not even synchronize the recovered projection into original state.
    workflow.state.todos = [{ id: "stale", stepId: "old", text: "Old plan", status: "completed" }];
    const original = workflow.snapshot();
    const result = await tool.execute({ items: [
      { id: "manual", text: "New manual task", status: "pending" },
      { id: "service", ...update },
    ] }, context);
    expect(result).toMatchObject({ isError: true, output: { code: "todo_plan_step_owned", stepId: "service", expected: { status: "pending" } } });
    expect(workflow.state).toEqual(original);
    expect(publish).not.toHaveBeenCalled();
  });

  it("accepts matching projected rows without replacing step metadata or publishing an event", async () => {
    const { workflow, publish, tool } = setup();
    plan(workflow, ["service"]);
    workflow.state.sequential!.steps[0]!.status = "verified";
    const result = await tool.execute({ items: [{ id: "service", text: "Implement service", status: "completed" }] }, context);
    expect(result).toMatchObject({ output: { count: 1, completed: 1, changed: false, items: [{ stepId: "service" }] } });
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the whole merged task list and supports 20 plan steps plus 20 manual tasks", async () => {
    const { workflow, publish, tool } = setup();
    plan(workflow, Array.from({ length: 20 }, (_, i) => `step-${i}`));
    const manual = Array.from({ length: 20 }, (_, i) => ({ id: `manual-${i}`, text: `Task ${i}`, status: "pending" }));
    const result = await tool.execute({ items: manual }, context);
    expect(result).toMatchObject({ output: { count: 40, manualCount: 20, changed: true } });
    expect(workflow.state.todos).toHaveLength(40);
    expect(publish).toHaveBeenCalledTimes(1);
    const matching = workflow.state.todos!.map(({ id, text, status }) => ({ id, text, status }));
    expect(await tool.execute({ items: matching }, context)).toMatchObject({ output: { count: 40, changed: false } });
    expect(publish).toHaveBeenCalledTimes(1);
    const before = workflow.snapshot();
    expect(await tool.execute({ items: [{ id: "overflow", text: "Task 21", status: "pending" }] }, context)).toMatchObject({ isError: true, output: { code: "todo_limit", manualLimit: 20, limit: 40 } });
    expect(workflow.state).toEqual(before);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized legacy manual lists during a query without events", async () => {
    const { workflow, publish, tool } = setup();
    plan(workflow, Array.from({ length: 20 }, (_, i) => `step-${i}`));
    workflow.state.todos = Array.from({ length: 25 }, (_, i) => ({ id: `manual-${i}`, text: `Task ${i}`, status: "pending" }));
    expect(await tool.execute({}, context)).toMatchObject({ output: { count: 40, manualCount: 20, changed: false } });
    expect(workflow.state.todos?.at(-1)?.id).toBe("manual-19");
    expect(publish).not.toHaveBeenCalled();
  });
});
