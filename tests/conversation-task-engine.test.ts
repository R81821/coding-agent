import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, WorkflowStateSchema, type AgentEvent, type ConversationTask, type ModelRequest, type RunSpec, type RunCheckpoint } from "@harness/protocol";
import { createDefaultToolRegistry, ToolRegistry } from "@harness/tools";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const check = { command: "node --test test/fixture.test.mjs", cwd: ".", timeoutMs: 1000 };
const nodes = ["a", "b", "c", "d"].map(id => ({ id, text: `Inspect ${id}`, dependsOn: id === "d" ? ["a"] : [], execution: { mode: "read" as const, prompt: `Read independent fixture ${id}` }, verification: [check] }));
const configure = (write = false) => call("configure", "advance_workflow", { action: "configure", summary: "Inspect independent repository parts", requirements: ["All requested parts are inspected and validated"], architecture: "Four independent reads with d requiring real verification of a", evidenceIds: ["recon"], mode: "adaptive", steps: write ? nodes.map(node => ({ ...node, execution: { ...node.execution, mode: "write" } })) : nodes, integration: [check] });

interface FixtureApi { engine: HarnessEngine; database: HarnessDatabase; spec: RunSpec; started: string[]; tasks: ConversationTask[]; requests: ModelRequest[]; events: AgentEvent[]; entered: Record<string, ReturnType<typeof gate>>; finish: Record<string, ReturnType<typeof gate>> }
type Script = (request: ModelRequest, index: number, api: FixtureApi) => AsyncGenerator<ProviderStreamEvent>;
const fixtures: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of fixtures.splice(0).reverse()) await close(); });

async function fixture(script: Script, options: { concurrency?: number; checkFences?: boolean; budget?: Partial<RunSpec["budget"]>; failFirst?: boolean; patch?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-queue-engine-")), workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true }); await writeFile(join(workspace, "fixture.txt"), "independent a b c d\n");
  await writeFile(join(workspace, "test", "fixture.test.mjs"), 'import { test } from "node:test"; test("fixture", () => {});\n');
  const crypto = await VaultCrypto.open(join(root, "key.json"), "queue-engine-fixture-password"), database = await HarnessDatabase.open(join(root, "db.sqlite"), crypto);
  const entered = Object.fromEntries(nodes.map(node => [node.id, gate()])), finish = Object.fromEntries(nodes.map(node => [node.id, gate()]));
  const started: string[] = [], tasks: ConversationTask[] = [], requests: ModelRequest[] = [], events: AgentEvent[] = [];
  const model = descriptor({ providerId: "fake", modelId: "queue-engine", displayName: "Queue fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  let turn = 0;
  const provider: ModelProvider = { id: "fake", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) { yield { type: "text_delta", delta: "The queue is paused with unverified work remaining." }; return; }
      yield* script(request, turn++, api);
    } };
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register({ contract: { name: "delegate", description: "fixture durable delegation", inputSchema: { type: "object" }, risk: "high", idempotent: false, timeoutMs: 10000 }, async execute() { throw new Error("The asynchronous queue must use its configured executor"); } });
  const engine = new HarnessEngine({ database, blobs: new EncryptedBlobStore(join(root, "blobs"), crypto), providers: [provider], tools,
    memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database),
    concurrency: { tasks: options.concurrency ?? 2, tools: 2, queueLength: 32 }, conversationTasks: { isolatedWrites: async () => false,
      async execute(task) {
        tasks.push(task); started.push(task.stepId);
        const durable = database.getConversationTask(task.taskId)!;
        expect(durable).toMatchObject({ executionState: "running", attemptId: task.attemptId, childRunId: task.childRunId });
        expect(durable.attempts.at(-1)!.reservationState).toBe("held"); expect(durable.startedAt).toBeUndefined();
        const child: RunSpec = { ...api.spec, id: task.childRunId!, parentRunId: api.spec.id, parentStepId: task.stepId, request: task.prompt, budget: durable.attempts.at(-1)!.reservation!, createdAt: nowIso() };
        database.saveRun(child, "running");
        const receipt = { taskId: task.taskId, stepId: task.stepId, childRunId: task.childRunId!, attemptId: task.attemptId!, planGeneration: task.planGeneration, mode: task.mode, startedAt: nowIso(), status: "running" as const };
        if (options.checkFences) {
          const { attemptId: omitted, ...withoutAttempt } = receipt; void omitted;
          expect(() => engine.recordTaskExecution(api.spec.id, withoutAttempt)).toThrow();
          expect(() => engine.recordTaskExecution(api.spec.id, { ...receipt, planGeneration: task.planGeneration + 1 })).toThrow();
        }
        engine.recordTaskExecution(api.spec.id, receipt);
        entered[task.stepId]!.resolve(); await finish[task.stepId]!.promise;
        engine.reportChildUsage(api.spec.id, { inputTokens: 10, outputTokens: 2, estimatedUsd: .01, turns: 1, toolCalls: 0 }, child.id);
        engine.reportChildUsage(api.spec.id, { inputTokens: 10, outputTokens: 2, estimatedUsd: .01, turns: 1, toolCalls: 0 }, child.id);
        const failed = options.failFirst === true && tasks.length === 1;
        database.updateRunStatus(child.id, failed ? "failed" : "completed");
        engine.recordTaskExecution(api.spec.id, { ...receipt, status: failed ? "failed" : "completed", finishedAt: nowIso(), summary: `${task.stepId} inspected`, ...(options.patch ? { patch: options.patch } : {}) });
        return { isError: failed, output: { summary: `${task.stepId} inspected` } };
      } } });
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "delegate"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, items: [] } };
  const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Inspect these independent repository parts", taskMode: "change", workspacePath: workspace, profileId: profile.id, attachments: [], budget: { maxTurns: 64, maxToolCalls: 120, maxDurationMs: 60000, maxUsd: 5, ...options.budget }, grants: [{ toolNames: ["delegate"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "high" }], createdAt: nowIso() };
  database.createSession({ id: spec.sessionId, title: "Queue fixture", workspacePath: workspace, profileId: profile.id, createdAt: nowIso(), updatedAt: nowIso() });
  const api: FixtureApi = { engine, database, spec, started, tasks, requests, events, entered, finish };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "fixture:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "fixture:user"), 0);
  });
  const result = new Promise<Extract<AgentEvent, { type: "result" }>>(resolveResult => engine.on("event", (event: AgentEvent) => { if (event.runId === spec.id && event.type === "result") resolveResult(event); }));
  fixtures.push(async () => {
    engine.cancel(spec.id); for (const gate of Object.values(finish)) gate.resolve(); await engine.close(); database.close(); crypto.dispose();
    const confined = relative(tmpdir(), root); if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  });
  return { ...api, start() { engine.start(spec, profile); }, result };
}

describe("conversation queue engine integration", { timeout: 30000 }, () => {
  it("reopens completed work as a new plan generation instead of reviving the old result", async () => {
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("first", "run_tasks", { stepIds: ["a"] }); return; }
      if (index === 3) { await api.entered.a!.promise; api.finish.a!.resolve(); yield call("wait-first", "wait_tasks", { mode: "all" }); return; }
      if (index === 4) { yield call("adopt-first", "integrate_tasks", { taskIds: [api.database.listConversationTasks(api.spec.id)[0]!.taskId] }); return; }
      if (index === 5) { yield call("reopen", "advance_workflow", { action: "reopen_step", stepId: "a", reason: "Inspect the repaired node again" }); return; }
      if (index === 6) { yield call("reopened", "run_tasks", { stepIds: ["a"] }); return; }
      if (index === 7) { yield call("wait-reopened", "wait_tasks", { mode: "all" }); return; }
      const rows = api.database.listConversationTasks(api.spec.id).sort((a, b) => a.planGeneration - b.planGeneration);
      expect(rows).toHaveLength(2); expect(rows[1]!.planGeneration).toBeGreaterThan(rows[0]!.planGeneration);
      expect(rows[1]!.taskId).not.toBe(rows[0]!.taskId); expect(rows[1]!.attemptId).not.toBe(rows[0]!.attemptId);
      expect(api.started).toEqual(["a", "a"]);
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "Reopened work needs new parent verification." };
    });
    h.start(); expect((await bounded(h.result, "reopened queue settles")).status).toBe("paused");
  });

  it("does not accept an ordinary read as a write integration receipt or verify child completion", async () => {
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(true); return; }
      if (index === 2) { yield call("write-child", "run_tasks", { stepIds: ["a"] }); return; }
      if (index === 3) {
        await bounded(api.entered.a!.promise, "write child starts"); api.finish.a!.resolve();
        yield call("wait-write", "wait_tasks", { mode: "all" }); return;
      }
      if (index === 4) {
        const task = api.database.listConversationTasks(api.spec.id)[0]!;
        expect(task).toMatchObject({ executionState: "awaiting_integration", acceptanceState: "pending" });
        yield call("fake-integration", "integrate_tasks", { taskIds: [task.taskId], evidenceId: "recon" }); return;
      }
      expect(api.events.find(event => event.type === "tool_finished" && event.callId === "fake-integration")).toMatchObject({ isError: true });
      expect(api.database.listConversationTasks(api.spec.id)[0]!.executionState).toBe("awaiting_integration");
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "Real integration and verification remain pending." };
    }, { patch: "a nonempty child patch" });
    h.start(); expect((await bounded(h.result, "write evidence rejected")).status).toBe("paused");
  });

  it("enqueues across model turns, fills a freed slot, fixes child identity and keeps verified prerequisites blocked", async () => {
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("first-batch", "run_tasks", { stepIds: ["a", "b", "d"] }); return; }
      if (index === 3) {
        await bounded(Promise.all([api.entered.a!.promise, api.entered.b!.promise]), "a and b start");
        api.finish.b!.resolve(); const b = api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "b")!;
        yield call("wait-b", "wait_tasks", { taskIds: [b.taskId], mode: "all" }); return;
      }
      if (index === 4) { yield call("next-batch", "run_tasks", { stepIds: ["c"] }); return; }
      if (index === 5) {
        await bounded(api.entered.c!.promise, "c fills b slot");
        expect(api.started).toEqual(["a", "b", "c"]);
        expect(api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "a")!.executionState).toBe("running");
        expect(api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "d")!.executionState).toBe("blocked");
        api.finish.a!.resolve(); api.finish.c!.resolve();
        yield call("wait-independent", "wait_tasks", { taskIds: api.database.listConversationTasks(api.spec.id).filter(task => task.stepId !== "d").map(task => task.taskId), mode: "all" }); return;
      }
      expect(index).toBe(6); expect(api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "d")!.executionState).toBe("blocked");
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "Execution produced evidence; real parent validation remains." };
    }, { checkFences: true });
    h.start(); const result = await bounded(h.result, "cross-batch parent pauses").catch(error => { throw new Error(`${String(error)} ${JSON.stringify({ started: h.started, requests: h.requests.length, queue: h.database.listConversationTasks(h.spec.id), events: h.events.slice(-10) })}`); });
    expect(result.status).toBe("paused"); await h.engine.waitForSettlement(h.spec.id);
    expect(h.started).toEqual(["a", "b", "c"]);
    const queue = h.database.listConversationTasks(h.spec.id);
    expect(queue.filter(task => task.executionState === "awaiting_integration")).toHaveLength(3);
    expect(queue.every(task => task.acceptanceState === "pending")).toBe(true);
    expect(queue.filter(task => task.attemptId).every(task => task.attempts.at(-1)!.reservationState === "settled")).toBe(true);
    expect(h.database.getLatestCheckpoint(h.spec.id)!.usage).toMatchObject({ inputTokens: 30, outputTokens: 6, estimatedUsd: .03 });
    expect(h.database.getLatestCheckpoint(h.spec.id)!.workflow!.sequential!.steps.find(step => step.id === "a")!.status).not.toBe("verified");
    expect(h.events.filter(event => event.type === "tool_finished" && ["first-batch", "next-batch"].includes(event.callId))).toHaveLength(2);
  });

  it("pause wakes wait_tasks before safe child settlement and prevents queued work from dispatching", async () => {
    const waiting = gate();
    const h = await fixture(async function* (_request, index) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("enqueue", "run_tasks", { stepIds: ["a", "b"] }); return; }
      yield call("wait-pause", "wait_tasks", { mode: "all", timeoutMs: 60000 });
    }, { concurrency: 1 });
    h.engine.on("event", (event: AgentEvent) => { if (event.runId === h.spec.id && event.type === "tool_started" && event.call.id === "wait-pause") waiting.resolve(); });
    h.start(); await bounded(waiting.promise, "wait tool starts"); await bounded(h.entered.a!.promise, "a starts");
    expect(h.engine.pause(h.spec.id)).toBe(true);
    let resultPublished = false; void h.result.then(() => { resultPublished = true; });
    await Promise.resolve(); expect(resultPublished).toBe(false); expect(h.started).toEqual(["a"]);
    h.finish.a!.resolve(); expect((await bounded(h.result, "safe paused result")).status).toBe("paused"); await h.engine.waitForSettlement(h.spec.id);
    expect(h.started).toEqual(["a"]); expect(h.database.listConversationTasks(h.spec.id).find(task => task.stepId === "b")!.executionState).toBe("queued");
    const waitResult = h.events.find(event => event.type === "tool_finished" && event.callId === "wait-pause");
    expect(waitResult).toMatchObject({ isError: false, output: { paused: true } });
  });

  it("blocks a task without a budget reservation and yields control without dispatch or model polling", async () => {
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("unfunded", "run_tasks", { stepIds: ["a"] }); return; }
      expect(index).toBe(3);
      expect(api.started).toEqual([]); expect(api.database.listConversationTasks(api.spec.id)[0]).toMatchObject({ executionState: "blocked", blockedReason: expect.stringContaining("Budget:"), attempts: [] });
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "No child budget remains." };
    }, { budget: { maxTurns: 4 } });
    h.start(); expect((await bounded(h.result, "unfunded queue yields")).status).toBe("review"); await h.engine.waitForSettlement(h.spec.id);
    expect(h.started).toEqual([]); expect(h.requests.length).toBeLessThanOrEqual(4);
    expect(h.database.listConversationTasks(h.spec.id)[0]).toMatchObject({ executionState: "blocked", blockedReason: expect.stringContaining("Budget:"), attempts: [] });
  });

  it("steering cancels old queued work while old running receipts remain audit records outside the current projection", async () => {
    let old: ConversationTask | undefined, steeringId: string | undefined;
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("old-generation", "run_tasks", { stepIds: ["a", "b"] }); return; }
      if (index === 3) {
        await bounded(api.entered.a!.promise, "old a starts"); old = api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "a")!;
        const submitted = api.engine.steer(api.spec.id, "Review the requirements before adopting prior child output");
        if (!submitted.accepted) throw new Error("Steering was unexpectedly rejected"); steeringId = submitted.messageId;
        expect(api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "b")!.executionState).toBe("cancelled");
        api.finish.a!.resolve(); yield call("wait-old", "wait_tasks", { taskIds: [old.taskId], mode: "all" }); return;
      }
      if (index === 4) { yield call("new-generation", "run_tasks", { stepIds: ["c"] }); return; }
      if (index === 5) {
        await bounded(api.entered.c!.promise, "new c starts"); const c = api.database.listConversationTasks(api.spec.id).find(task => task.stepId === "c")!;
        expect(c.planGeneration).toBeGreaterThan(old!.planGeneration); expect(c.source).toMatchObject({ kind: "steering", messageId: steeringId });
        api.finish.c!.resolve(); yield call("wait-new", "wait_tasks", { taskIds: [c.taskId], mode: "all" }); return;
      }
      expect(index).toBe(6);
      expect(api.database.getConversationTask(old!.taskId)).toMatchObject({ executionState: "awaiting_integration", summary: "a inspected", acceptanceState: "pending" });
      expect(api.database.getLatestCheckpoint(api.spec.id)!.workflow!.sequential!.taskExecutions.some(record => record.taskId === old!.taskId)).toBe(false);
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "Prior output needs explicit applicability review." };
    }, { concurrency: 1 });
    h.start(); const result = await bounded(h.result, "steered queue settles").catch(error => { throw new Error(`${String(error)} ${JSON.stringify({ started: h.started, requests: h.requests.length, queue: h.database.listConversationTasks(h.spec.id), events: h.events.slice(-10) })}`); });
    expect(result.status).toBe("paused"); await h.engine.waitForSettlement(h.spec.id);
    expect(h.started).toEqual(["a", "c"]);
    expect(h.database.getLatestCheckpoint(h.spec.id)!.workflow!.sequential!.taskExecutions.map(record => record.stepId)).toEqual(["c"]);
  });

  it("retries with a new attempt and counts late reports for the old child once", async () => {
    let first: ConversationTask | undefined;
    const h = await fixture(async function* (_request, index, api) {
      if (index === 0) { yield call("recon", "read_file", { path: "fixture.txt" }); return; }
      if (index === 1) { yield configure(); return; }
      if (index === 2) { yield call("first-attempt", "run_tasks", { stepIds: ["a"] }); return; }
      if (index === 3) {
        await bounded(api.entered.a!.promise, "first attempt starts"); first = api.database.listConversationTasks(api.spec.id)[0]!; api.finish.a!.resolve();
        yield call("wait-first", "wait_tasks", { taskIds: [first.taskId], mode: "all" }); return;
      }
      if (index === 4) {
        api.engine.retryConversationTask(api.spec.sessionId, api.spec.id, first!.taskId, "The failed read has been inspected and is safe to retry");
        yield call("wait-retry", "wait_tasks", { taskIds: [first!.taskId], mode: "all" }); return;
      }
      expect(index).toBe(5);
      const retried = api.database.getConversationTask(first!.taskId)!; expect(retried.attempts).toHaveLength(2); expect(retried.attemptId).not.toBe(first!.attemptId);
      api.engine.reportChildUsage(api.spec.id, { inputTokens: 10, outputTokens: 2, estimatedUsd: .01, turns: 1, toolCalls: 0 }, first!.childRunId);
      expect(api.database.getLatestCheckpoint(api.spec.id)!.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, estimatedUsd: .02 });
      expect(() => api.engine.recordTaskExecution(api.spec.id, { taskId: first!.taskId, stepId: "a", childRunId: first!.childRunId!, attemptId: first!.attemptId!, planGeneration: first!.planGeneration, mode: "read", status: "completed", summary: "stale output" })).toThrow();
      api.engine.pause(api.spec.id); yield { type: "text_delta", delta: "Retried output remains pending integration and validation." };
    }, { failFirst: true, concurrency: 1 });
    h.start(); expect((await bounded(h.result, "retry settles")).status).toBe("paused"); await h.engine.waitForSettlement(h.spec.id);
    expect(h.started).toEqual(["a", "a"]);
  });

  it("recovery atomically accounts late costs on every historical attempt and does not charge again", async () => {
    const h = await fixture(async function* () { throw new Error("Recovery must not request a model"); });
    const cp: RunCheckpoint = { id: "recovery-parent", runId: h.spec.id, sequence: 0, reason: "manual", status: "running", transcript: [], usage: { inputTokens: 30, outputTokens: 0, estimatedUsd: .3 }, turns: 0, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso(),
      workflow: WorkflowStateSchema.parse({ phase: "small_edit", objective: "Recovery fixture", requirements: [], context: "", plan: [], hypotheses: [], observations: [], relevantFiles: [], changedFiles: [], revision: 0, localRevision: 0, broaderRevision: 0, diffRevision: 0, requirementsRevision: 0, reviewedRevision: 0, failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "", sequential: { generation: 0, steps: nodes } }) };
    h.database.saveRun(h.spec, "running"); h.database.saveCheckpoint(cp);
    h.database.enqueueConversationTasks([{ taskId: "recover", sessionId: h.spec.sessionId, parentRunId: h.spec.id, stepId: "a", planGeneration: 0, source: { kind: "run" }, mode: "read", prompt: "recover fixture", createdAt: nowIso(), updatedAt: nowIso() }]);
    const first = h.database.claimConversationTask("recover")!;
    h.database.updateConversationTask("recover", { executionState: "failed", accountedUsage: { inputTokens: 10, estimatedUsd: .1 } }, { expectedAttemptId: first.attemptId! });
    h.database.updateConversationTask("recover", { executionState: "queued", retryReason: "safe retry" }); const second = h.database.claimConversationTask("recover")!;
    h.database.updateConversationTask("recover", { executionState: "interrupted", accountedUsage: { inputTokens: 20, estimatedUsd: .2 } }, { expectedAttemptId: second.attemptId! });
    for (const [attempt, inputTokens, estimatedUsd] of [[first, 50, .5], [second, 40, .4]] as const) {
      h.database.saveRun({ ...h.spec, id: attempt.childRunId!, parentRunId: h.spec.id, parentStepId: "a" }, "completed");
      h.database.saveCheckpoint({ ...cp, id: `cp-${attempt.childRunId}`, runId: attempt.childRunId!, workflow: undefined, usage: { inputTokens, outputTokens: 0, estimatedUsd }, status: "completed" });
    }
    expect(h.engine.recoverInterrupted()).toContain(h.spec.id);
    const once = h.database.getLatestCheckpoint(h.spec.id)!; expect(once.usage.inputTokens).toBe(90); expect(once.usage.estimatedUsd).toBeCloseTo(.9);
    expect(h.database.getConversationTask("recover")!.attempts.map(attempt => attempt.accountedUsage.inputTokens)).toEqual([50, 40]);
    h.database.updateRunStatus(h.spec.id, "running"); h.engine.recoverInterrupted();
    const twice = h.database.getLatestCheckpoint(h.spec.id)!; expect(twice.usage).toEqual(once.usage); expect(h.requests).toEqual([]);
  });
});
