import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec, type TaskExecution, type WorkflowState } from "@harness/protocol";
import { createDefaultToolRegistry, ToolRegistry } from "@harness/tools";
import { waitForRunResult } from "../packages/core/src/run-completion.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const check = { command: "node --test test.test.mjs", cwd: ".", timeoutMs: 10000 };
type Scenario = "completed" | "deny" | "absent" | "disabled" | "pause" | "retry";
interface DispatchedTask { id: string; stepId: string; prompt: string; mode: "read" | "write"; writePaths?: string[] }

async function fixture(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "harness-graph-runtime-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "independent source modules\n");
  await writeFile(join(workspace, "test.test.mjs"), 'import { test } from "node:test"; test("fixture", () => {});\n');
  const vault = await VaultCrypto.open(join(root, "key.json"), "graph-runtime-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const childIds: string[] = [];
  const dispatches: DispatchedTask[][] = [];
  const identityErrors: string[] = [];
  const pauseStates: boolean[][] = [];
  let latest: WorkflowState | undefined;
  let phase = 0;
  const childTurns = new Map<string, number>();
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  const model = descriptor({ providerId: "fake", modelId: "graph-runtime", displayName: "Graph runtime fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "review") throw new Error("Independent model review must remain disabled");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "Paused with child task artifacts preserved; parent verification is pending." }; return;
      }
      if (request.runId !== spec.id) {
        const turn = childTurns.get(request.runId) ?? 0;
        childTurns.set(request.runId, turn + 1);
        if (turn === 0) yield call(`child-read-${request.runId}`, "read_file", { path: "source.txt" });
        else yield { type: "text_delta", delta: "The complete source read identifies independent modules." };
        return;
      }
      const current = phase++;
      if (current === 0) {
        yield call("context", "read_file", { path: "source.txt" });
        yield call("configure", "advance_workflow", {
          action: "configure", summary: "Investigate independent nodes before parent integration", requirements: ["Independent nodes produce findings"],
          architecture: "Two nodes inspect independent concerns and return their findings", evidenceIds: ["context"], startStepId: "a",
          steps: [
            { id: "a", text: "Inspect source A", dependsOn: [], verification: [check], priority: 0, execution: { mode: scenario === "deny" ? "write" : "read", writePaths: ["source.txt"] } },
            { id: "b", text: "Inspect source B", dependsOn: scenario === "retry" ? ["a"] : [], verification: [check], priority: 10, execution: { mode: "read" } },
          ], integration: [check],
        });
        return;
      }
      if (current === 1) {
        yield call("dispatch", "run_tasks", scenario === "retry" || scenario === "deny" ? { stepIds: ["a"], maxParallel: 2 } : { maxParallel: 2 }); return;
      }
      if (current === 2) {
        yield call("default-redispatch", "run_tasks", {}); return;
      }
      if (current === 3 && scenario === "retry") {
        yield call("retry-without-reason", "run_tasks", { stepIds: ["a"] }); return;
      }
      if (current === 4 && scenario === "retry") {
        yield call("retry-with-reason", "run_tasks", { stepIds: ["a"], reason: "Inspected the paused child and confirmed that no repository writes occurred" }); return;
      }
      engine.pause(spec.id);
      yield { type: "text_delta", delta: "Parent integration and real tests remain pending." };
    },
  };
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: scenario === "disabled" ? ["read_file"] : ["read_file", "delegate"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled" } };
  const spec: RunSpec = {
    id: newId("run"), sessionId: "graph-runtime", request: "Coordinate independent graph nodes and preserve verification boundaries", workspacePath: workspace,
    taskMode: "change", profileId: profile.id, attachments: [], grants: [], budget: { ...profile.budget, maxTurns: 10, maxToolCalls: 40 }, createdAt: nowIso(),
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanups.push(async () => {
    await engine.close(); database.close(); vault.dispose();
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe graph fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  if (scenario !== "absent") tools.register({
    contract: { name: "delegate", description: "Real child run fixture", inputSchema: { type: "object", properties: { tasks: { type: "array" }, maxParallel: { type: "integer" } }, required: ["tasks"] }, risk: "high", idempotent: false, timeoutMs: 15000 },
    assessRisk: input => (input.tasks as DispatchedTask[]).some(task => task.mode === "write") ? "high" : "read",
    async execute(input, context) {
      const tasks = input.tasks as DispatchedTask[];
      dispatches.push(tasks);
      const starts: Array<{ record: TaskExecution; completion: Promise<Extract<AgentEvent, { type: "result" }>> }> = [];
      for (const task of tasks) {
        const child: RunSpec = { ...spec, id: newId("run_child"), request: task.prompt, taskMode: "analysis", parentRunId: spec.id, parentStepId: task.stepId, createdAt: nowIso(), grants: [], budget: { ...profile.budget, maxTurns: 4, maxToolCalls: 6 } };
        const childProfile: Profile = { ...profile, toolNames: ["read_file"] };
        const record: TaskExecution = { taskId: task.id, stepId: task.stepId, childRunId: child.id, mode: task.mode, status: "running", startedAt: nowIso(), ...(task.writePaths ? { writePaths: task.writePaths } : {}) };
        const completion = waitForRunResult(engine, child.id, context.signal, () => {
          engine.start(child, childProfile);
          childIds.push(child.id);
          engine.recordTaskExecution(spec.id, record);
          if (scenario === "retry" && dispatches.length === 1) engine.pause(child.id);
        });
        starts.push({ record, completion });
      }
      if (scenario === "completed") {
        const attempt = (record: TaskExecution) => {
          try { engine.recordTaskExecution(spec.id, record); identityErrors.push("accepted"); }
          catch (error) { identityErrors.push(String(error)); }
        };
        attempt({ ...starts[0]!.record, childRunId: "invented-child" });
        attempt({ ...starts[0]!.record, stepId: starts[1]!.record.stepId, childRunId: starts[1]!.record.childRunId });
        attempt({ ...starts[0]!.record, mode: "write" });
        attempt({ ...starts[0]!.record, writePaths: ["unowned.txt"] });
      }
      if (scenario === "pause") {
        engine.pause(spec.id);
        pauseStates.push([engine.isPausing(spec.id), ...starts.map(item => engine.isPausing(item.record.childRunId!))]);
      }
      const results = await Promise.all(starts.map(async ({ record, completion }) => {
        const result = await completion;
        const childCheckpoint = database.getLatestCheckpoint(record.childRunId!)!;
        const usage = { inputTokens: childCheckpoint.usage.inputTokens, outputTokens: childCheckpoint.usage.outputTokens, estimatedUsd: childCheckpoint.usage.estimatedUsd, costKnown: childCheckpoint.usage.costKnown ?? false, turns: childCheckpoint.turns, toolCalls: childCheckpoint.toolCalls };
        engine.reportChildUsage(spec.id, usage, record.childRunId);
        const accounted = database.getLatestCheckpoint(spec.id)!;
        engine.reportChildUsage(spec.id, usage, record.childRunId);
        const repeated = database.getLatestCheckpoint(spec.id)!;
        expect({ turns: repeated.turns, toolCalls: repeated.toolCalls, usage: repeated.usage }).toEqual({ turns: accounted.turns, toolCalls: accounted.toolCalls, usage: accounted.usage });
        engine.recordTaskExecution(spec.id, { ...record, status: result.status === "completed" ? "completed" : result.status === "paused" || result.status === "cancelled" ? "interrupted" : "failed", finishedAt: nowIso(), summary: result.text });
        return { taskId: record.taskId, stepId: record.stepId, runId: record.childRunId, status: result.status, text: result.text };
      }));
      return { output: { results } };
    },
  });
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.runId === spec.id && event.type === "workflow_updated") latest = structuredClone(event.workflow);
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, scenario !== "deny", "test:user"), 0);
    const stopCall = scenario === "absent" || scenario === "disabled" ? "configure" : scenario === "deny" ? "dispatch" : scenario === "completed" ? "default-redispatch" : scenario === "retry" ? "retry-with-reason" : undefined;
    if (event.runId === spec.id && event.type === "tool_finished" && event.callId === stopCall) engine.pause(spec.id);
  });
  async function runParent() {
    const result = await waitForRunResult(engine, spec.id, AbortSignal.timeout(20000), () => engine.start(spec, profile));
    await engine.waitForSettlement(spec.id);
    return result;
  }
  const output = (id: string) => events.find((event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.runId === spec.id && event.type === "tool_finished" && event.callId === id);
  return { runParent, engine, database, spec, events, requests, dispatches, childIds, identityErrors, pauseStates, output, latest: () => latest };
}

describe("task graph adapter through real engine and child runs", { timeout: 30000 }, () => {
  it("dispatches ready nodes by priority, records real child identity, and requires parent tests after children finish", async () => {
    const f = await fixture("completed");
    expect((await f.runParent()).status).toBe("paused");
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]!.map(task => task.stepId)).toEqual(["b", "a"]);
    expect(f.childIds).toHaveLength(2);
    for (const id of f.childIds) {
      const child = f.database.getRun(id)!;
      expect(child.spec).toMatchObject({ parentRunId: f.spec.id, taskMode: "analysis" });
      expect(["a", "b"]).toContain(child.spec.parentStepId);
      expect(child.status).toBe("completed");
      expect(f.database.listEvents(id).filter(event => event.type === "result" && event.status === "completed")).toHaveLength(1);
    }
    expect(f.identityErrors).toHaveLength(4);
    expect(f.identityErrors.every(error => error !== "accepted")).toBe(true);
    expect(f.latest()?.sequential?.taskExecutions).toHaveLength(2);
    expect(f.events.some(event => event.runId === f.spec.id && event.type === "workflow_updated"
      && event.workflow.sequential?.taskExecutions.length === 2
      && event.workflow.sequential.taskExecutions.every(task => task.status === "running" && !!task.childRunId))).toBe(true);
    expect(f.latest()?.sequential?.taskExecutions.every(task => task.status === "completed" && f.childIds.includes(task.childRunId!))).toBe(true);
    for (const task of f.latest()!.sequential!.taskExecutions) {
      const child = f.database.getLatestCheckpoint(task.childRunId!)!;
      expect(task.accountedUsage).toMatchObject({ turns: child.turns, toolCalls: child.toolCalls, inputTokens: child.usage.inputTokens, outputTokens: child.usage.outputTokens });
    }
    expect(f.latest()?.sequential?.steps.every(step => step.status === "in_progress" && step.check.status === "pending")).toBe(true);
    expect(f.database.listVerificationRuns(f.spec.id)).toEqual([]);
    expect(f.output("default-redispatch")).toMatchObject({ isError: true, output: { code: "graph_tasks_ineligible" } });
    expect(f.database.getLatestCheckpoint(f.spec.id)?.workflow?.sequential?.taskExecutions).toEqual(f.latest()?.sequential?.taskExecutions);
    expect(f.requests.some(request => request.purpose === "review")).toBe(false);
  });

  it("denies delegate write permission before creating task records or children", async () => {
    const f = await fixture("deny");
    expect((await f.runParent()).status).toBe("paused");
    expect(f.events.some(event => event.runId === f.spec.id && event.type === "approval_required")).toBe(true);
    expect(f.output("dispatch")).toMatchObject({ isError: true, output: { code: "graph_tasks_permission_denied" } });
    expect(f.dispatches).toEqual([]);
    expect(f.childIds).toEqual([]);
    expect(f.latest()?.sequential?.taskExecutions).toEqual([]);
  });

  it.each(["absent", "disabled"] as const)("withholds run_tasks when delegate is %s", async scenario => {
    const f = await fixture(scenario);
    expect((await f.runParent()).status).toBe("paused");
    const parentRequests = f.requests.filter(request => request.runId === f.spec.id);
    expect(parentRequests.length).toBeGreaterThan(0);
    expect(parentRequests.every(request => !request.tools.some(tool => tool.name === "run_tasks"))).toBe(true);
    expect(f.dispatches).toEqual([]);
  });

  it("propagates parent pause to real child runs and preserves interrupted task records", async () => {
    const f = await fixture("pause");
    expect((await f.runParent()).status).toBe("paused");
    expect(f.pauseStates).toEqual([[true, true, true]]);
    expect(f.childIds).toHaveLength(2);
    expect(f.childIds.every(id => f.database.getRun(id)?.status === "paused")).toBe(true);
    expect(f.latest()?.sequential?.taskExecutions.every(task => task.status === "interrupted" && !!task.childRunId)).toBe(true);
    expect(f.latest()?.sequential?.steps.some(step => step.status === "verified")).toBe(false);
    expect(f.database.getLatestCheckpoint(f.spec.id)?.workflow?.sequential?.taskExecutions).toEqual(f.latest()?.sequential?.taskExecutions);
  });

  it("requires explicit reason to retry an interrupted node and never replays its child", async () => {
    const f = await fixture("retry");
    expect((await f.runParent()).status).toBe("paused");
    expect(f.dispatches).toHaveLength(2);
    expect(f.dispatches.every(tasks => tasks.length === 1 && tasks[0]?.stepId === "a")).toBe(true);
    expect(f.dispatches[0]![0]!.id).not.toBe(f.dispatches[1]![0]!.id);
    expect(f.output("default-redispatch")).toMatchObject({ isError: true, output: { code: "graph_tasks_ineligible" } });
    expect(f.output("retry-without-reason")).toMatchObject({ isError: true });
    expect(JSON.stringify(f.output("retry-without-reason")?.output)).toContain("explicit retry reason");
    expect(f.output("retry-with-reason")?.isError).not.toBe(true);
    expect(f.childIds).toHaveLength(2);
    expect(f.childIds[0]).not.toBe(f.childIds[1]);
    expect(f.database.getRun(f.childIds[0]!)?.status).toBe("paused");
    expect(f.database.getRun(f.childIds[1]!)?.status).toBe("completed");
    expect(f.engine.isActive(f.childIds[0]!)).toBe(false);
    expect(f.latest()?.sequential?.taskExecutions.find(task => task.stepId === "a")).toMatchObject({ status: "completed", childRunId: f.childIds[1] });
    expect(f.latest()?.sequential?.steps.find(step => step.id === "a")?.status).toBe("in_progress");
    expect(f.database.listVerificationRuns(f.spec.id)).toEqual([]);
  });
});
