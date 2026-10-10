import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { applyPatchTool, createDefaultToolRegistry, terminalTool, ToolRegistry } from "@harness/tools";

const aCommand = "node --test test/a.test.mjs";
const bCommand = "node --test test/b.test.mjs";
const integrationCommand = "node --test test/integration.test.mjs";
const finalBody = "Both independent modules are implemented and their real local and integration suites pass.";
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 10000 });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const patchSource = (module: "a" | "b", before: number, after: number) => call(`patch-${module}-${after}`, "patch", {
  patch: `--- a/${module}.mjs\n+++ b/${module}.mjs\n@@ -1 +1 @@\n-export const ${module} = ${before};\n+export const ${module} = ${after};\n`,
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Mutation = "source" | "test" | "config";
async function fixture(options: { mutation?: Mutation; pauseFirstSuite?: boolean; forceBLocal?: boolean; failForcedAOnce?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-task-graph-engine-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "a.mjs"), "export const a = 0;\n");
  await writeFile(join(workspace, "b.mjs"), "export const b = 0;\n");
  for (const module of ["a", "b"]) await writeFile(join(workspace, "test", `${module}.test.mjs`), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    `import { ${module} } from "../${module}.mjs";`,
    `test("${module} is positive", () => assert.ok(${module} >= 1));`,
    ...(module === "a" && options.failForcedAOnce ? ['test("temporary executor condition is healthy", () => assert.notEqual(process.env.HARNESS_TASK_GRAPH_FAULT, "fail", "intentional executor fault"));'] : []),
  ].join("\n") + "\n");
  await writeFile(join(workspace, "test", "integration.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { a } from "../a.mjs";',
    'import { b } from "../b.mjs";',
    'test("both modules compose", () => assert.ok(a >= 1 && b >= 1 && a + b >= 2));',
  ].join("\n") + "\n");
  const vault = await VaultCrypto.open(join(root, "key.json"), "task-graph-engine-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const commands: string[] = [];
  const states: WorkflowState[] = [];
  let latest: WorkflowState | undefined;
  let phase = "prepare";
  let paused = false;
  let faultInjected = false;
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register(applyPatchTool);
  tools.register({ ...terminalTool, async execute(input, context) {
    const command = String(input.command);
    commands.push(command);
    const injectFault = options.failForcedAOnce && !faultInjected && command === aCommand && commands.filter(command => command === aCommand).length === 2;
    const originalFault = process.env.HARNESS_TASK_GRAPH_FAULT;
    if (injectFault) { faultInjected = true; process.env.HARNESS_TASK_GRAPH_FAULT = "fail"; }
    let result;
    try { result = await terminalTool.execute(input, context); }
    finally {
      if (injectFault) {
        if (originalFault === undefined) delete process.env.HARNESS_TASK_GRAPH_FAULT;
        else process.env.HARNESS_TASK_GRAPH_FAULT = originalFault;
      }
    }
    if (options.pauseFirstSuite && !paused && command === bCommand && !result.isError) {
      paused = true;
      expect(engine.pause(spec.id)).toBe(true);
    }
    return result;
  } });
  const model = descriptor({ providerId: "fake", modelId: "task-graph-engine", displayName: "Task graph engine fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "review") throw new Error("Independent model reviews must not run");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "The task graph still lacks current runtime verification." }; return;
      }
      if (phase === "prepare") {
        yield call("a-context", "read_file", { path: "a.mjs" });
        yield call("b-context", "read_file", { path: "b.mjs" });
        yield action("configure-graph", {
          action: "configure", summary: "Implement two independent positive values", requirements: ["Both independent modules export positive values", "Both values compose correctly"],
          architecture: "Independent a.mjs and b.mjs modules can be implemented separately", evidenceIds: ["a-context", "b-context"],
          // Intentionally place the lower-priority node first. The runtime must select by graph
          // policy rather than the array position, and no startStepId is supplied.
          steps: [
            { id: "b", text: "Implement b", priority: 10, dependsOn: [], verification: [check(bCommand)] },
            { id: "a", text: "Implement a", priority: 90, dependsOn: [], verification: [check(aCommand)] },
          ], integration: [check(integrationCommand)],
        });
        yield action("select-by-priority", { action: "select_next" });
        phase = "implement-a"; return;
      }
      if (phase === "implement-a") {
        yield patchSource("a", 0, 1);
        if (options.pauseFirstSuite) {
          yield action("start-b-before-batch", { action: "start_step", stepId: "b" });
          yield patchSource("b", 0, 1);
          phase = "batch-local";
        } else phase = "a-local";
        return;
      }
      if (phase === "a-local") {
        yield call("a-local-suite", "run_verification", check(aCommand));
        phase = "implement-b"; return;
      }
      if (phase === "implement-b") {
        // No explicit start command: before the write the runtime autonomously selects the next
        // eligible node after a's real verification completed.
        yield patchSource("b", 0, 1);
        phase = "b-local"; return;
      }
      if (phase === "b-local") {
        yield call("b-local-suite", "run_verification", { ...check(bCommand), ...(options.forceBLocal || options.failForcedAOnce ? { force: true } : {}) });
        phase = options.failForcedAOnce ? "retry-after-fault" : options.mutation ? "mutate" : "integration"; return;
      }
      if (phase === "retry-after-fault") {
        // The executor condition has been repaired. A newer real exit 1 must prevent reviving
        // the older passing A receipt even though the static dependency fingerprint is equal.
        yield call("retry-local-after-fault", "run_verification", check(aCommand));
        phase = "integration"; return;
      }
      if (phase === "mutate") {
        yield action("reopen-a", { action: "reopen_step", stepId: "a", reason: "Change covered code, assertions, or global configuration and obtain fresh evidence" });
        if (options.mutation === "source") yield patchSource("a", 1, 2);
        else if (options.mutation === "test") yield call("patch-a-test", "patch", { patch: '--- a/test/a.test.mjs\n+++ b/test/a.test.mjs\n@@ -4 +4 @@\n-test("a is positive", () => assert.ok(a >= 1));\n+test("a is positive", () => assert.ok(a >= 1, "a must remain positive"));\n' });
        else yield call("add-tsconfig", "patch", { patch: '--- /dev/null\n+++ b/tsconfig.json\n@@ -0,0 +1 @@\n+{"compilerOptions":{"strict":true}}\n' });
        phase = "mutated-local"; return;
      }
      if (phase === "mutated-local") {
        yield call("mutated-local-suite", "run_verification", check(aCommand));
        phase = "integration"; return;
      }
      if (phase === "batch-local" || phase === "resume-local") {
        yield call(phase === "resume-local" ? "resumed-local-suite" : "batch-local-suite", "run_verification", check(bCommand));
        phase = "integration"; return;
      }
      if (phase === "integration") {
        yield call("integration-suite", "run_verification", { ...check(integrationCommand), stage: "broader" });
        phase = "diff"; return;
      }
      if (phase === "diff") {
        yield call("accepted-diff", "workspace_diff", {});
        phase = "accept"; return;
      }
      if (phase === "accept") {
        if (!latest) throw new Error("Runtime workflow state must exist before requirement acceptance");
        yield call("requirements", "check_requirements", { evidence: latest.requirementIds.map(requirementId => ({
          requirementId, summary: "Current real local and integration tests cover both values and their composition",
          observationIds: ["accepted-diff"], verificationIds: [latest!.localCheck.runId, latest!.broaderCheck.runId], diffObservationId: "accepted-diff", passed: true,
        })) });
        phase = "report"; return;
      }
      yield { type: "text_delta", delta: finalBody };
    },
  };
  const engine = new HarnessEngine({ database, blobs: new EncryptedBlobStore(join(root, "blobs"), vault), providers: [provider], tools,
    memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(async () => {
    await engine.close(); database.close(); vault.dispose();
    const confined = relative(tmpdir(), root);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "apply_patch", "terminal"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled" } };
  const spec: RunSpec = { id: newId("run"), sessionId: "task-graph-engine", request: "Implement independent positive a and b values and their composition", workspacePath: workspace,
    taskMode: "auto", profileId: profile.id, attachments: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 24, maxToolCalls: 80 }, grants: [] };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "workflow_updated") { latest = structuredClone(event.workflow); states.push(latest); }
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
  });
  async function run(start: () => void) {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Task graph engine scenario timed out")); }, 25000);
      const onEvent = (event: AgentEvent) => {
        if (event.type !== "result") return;
        clearTimeout(timer); engine.off("event", onEvent); resolve(event);
      };
      engine.on("event", onEvent); start();
    });
    await engine.waitForSettlement(spec.id);
    return result;
  }
  return { engine, database, events, requests, commands, states, spec, profile, workspace, run, latest: () => latest,
    resumeLocal: () => { phase = "resume-local"; } };
}

function expectAccepted(f: Awaited<ReturnType<typeof fixture>>, result: Extract<AgentEvent, { type: "result" }>, expectedFailedCallIds: string[] = []) {
  expect(result.status, JSON.stringify({ text: result.text, stop: result.stop, workflow: f.latest(), tools: f.events.filter(event => event.type === "tool_finished" && event.isError) })).toBe("completed");
  expect(f.events.filter(event => event.type === "result" && event.status === "completed")).toHaveLength(1);
  expect(f.events.filter(event => event.type === "text_delta" && event.delta === finalBody)).toHaveLength(1);
  const pauseSequence = f.events.findLast(event => event.type === "result" && event.status === "paused")?.sequence ?? -1;
  expect(f.events.flatMap(event => event.sequence > pauseSequence && event.type === "tool_finished" && event.isError ? [event.callId] : [])).toEqual(expectedFailedCallIds);
  expect(f.requests.some(request => request.purpose === "review")).toBe(false);
  expect(f.latest()?.requirementsRevision).toBe(f.latest()?.revision);
  expect(f.latest()?.sequential?.steps.every(step => step.status === "verified")).toBe(true);
  const broader = f.database.listVerificationRuns(f.spec.id).find(run => run.stage === "broader" && run.passed);
  expect(broader?.results).toMatchObject([{ command: integrationCommand, exitCode: 0, passed: true }]);
}

describe("task graph scheduling, dependency receipts, and suite recovery through the real engine", { timeout: 35000 }, () => {
  it("selects a high-priority node, autonomously advances after verification, and reuses only the unaffected real test receipt", async () => {
    const f = await fixture();
    const result = await f.run(() => f.engine.start(f.spec, f.profile));
    expectAccepted(f, result);
    const configured = f.states.find(state => state.sequential?.steps.length === 2);
    expect(configured?.sequential).toMatchObject({ selectionPolicy: "autonomous", activeStepId: "" });
    const firstStarted = f.states.find(state => state.sequential?.activeStepId);
    expect(firstStarted?.sequential?.activeStepId).toBe("a");
    expect(f.states.some(state => state.sequential?.activeStepId === "b" && state.sequential.steps.find(step => step.id === "a")?.status === "verified")).toBe(true);
    expect(f.commands).toEqual([aCommand, bCommand, integrationCommand]);
    const locals = f.database.listVerificationRuns(f.spec.id).filter(run => run.stage === "local" && run.passed).sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
    expect(locals).toHaveLength(2);
    const original = locals[0]!.results.find(result => result.command === aCommand)!;
    const reused = locals[1]!.results.find(result => result.command === aCommand)!;
    expect(original).toMatchObject({ dependencyComplete: true, dependencyPaths: ["a.mjs", "test/a.test.mjs"], exitCode: 0, passed: true });
    expect(original.dependencyFingerprint).toBeTruthy();
    expect(reused).toMatchObject({ dependencyComplete: true, dependencyFingerprint: original.dependencyFingerprint, reusedFromRunId: locals[0]!.id, durationMs: 0, passed: true });
    expect(locals[1]!.revision).toBeGreaterThan(locals[0]!.revision!);
    expect((await readFile(join(f.workspace, "a.mjs"), "utf8")).trim()).toBe("export const a = 1;");
    expect((await readFile(join(f.workspace, "b.mjs"), "utf8")).trim()).toBe("export const b = 1;");
  });

  it.each(["source", "test", "config"] as const)("reruns affected real tests after changing %s and never promotes an old dependency receipt", async mutation => {
    const f = await fixture({ mutation });
    expectAccepted(f, await f.run(() => f.engine.start(f.spec, f.profile)));
    const expected = mutation === "config" ? [aCommand, bCommand, bCommand, aCommand, integrationCommand] : [aCommand, bCommand, aCommand, integrationCommand];
    expect(f.commands).toEqual(expected);
    const locals = f.database.listVerificationRuns(f.spec.id).filter(run => run.stage === "local" && run.passed).sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
    expect(locals).toHaveLength(3);
    const firstA = locals[0]!.results.find(result => result.command === aCommand)!;
    const currentA = locals.at(-1)!.results.find(result => result.command === aCommand)!;
    expect(currentA.exitCode).toBe(0);
    expect(currentA.dependencyFingerprint).not.toBe(firstA.dependencyFingerprint);
    expect(currentA.reusedFromRunId).toBeUndefined();
    if (mutation === "config") expect(locals.at(-1)!.results.every(result => !result.reusedFromRunId)).toBe(true);
    else expect(locals.at(-1)!.results.find(result => result.command === bCommand)?.reusedFromRunId).toBe(locals[1]!.id);
  });

  it("reruns an unchanged real suite when the model explicitly requests force=true", async () => {
    const f = await fixture({ forceBLocal: true });
    expectAccepted(f, await f.run(() => f.engine.start(f.spec, f.profile)));
    expect(f.commands).toEqual([aCommand, bCommand, aCommand, integrationCommand]);
    const locals = f.database.listVerificationRuns(f.spec.id).filter(run => run.stage === "local" && run.passed).sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
    expect(locals).toHaveLength(2);
    const originalA = locals[0]!.results.find(result => result.command === aCommand)!;
    const forcedA = locals[1]!.results.find(result => result.command === aCommand)!;
    expect(forcedA).toMatchObject({ dependencyComplete: true, dependencyFingerprint: originalA.dependencyFingerprint, exitCode: 0, passed: true });
    expect(forcedA.reusedFromRunId).toBeUndefined();
    expect(forcedA.durationMs).toBeGreaterThan(0);
  });

  it("executes the suite again after a newer real failed receipt instead of reviving an older matching pass", async () => {
    const f = await fixture({ failForcedAOnce: true });
    expectAccepted(f, await f.run(() => f.engine.start(f.spec, f.profile)), ["b-local-suite"]);
    expect(f.commands).toEqual([aCommand, bCommand, aCommand, aCommand, integrationCommand]);
    const locals = f.events.flatMap(event => event.type === "verification_finished" && event.verification.stage === "local" ? [event.verification] : []);
    expect(locals).toHaveLength(3);
    const originalA = locals[0]!.results.find(result => result.command === aCommand)!;
    const failedA = locals[1]!.results.find(result => result.command === aCommand)!;
    const repairedA = locals[2]!.results.find(result => result.command === aCommand)!;
    expect(locals[1]!.passed).toBe(false);
    expect(failedA).toMatchObject({ dependencyComplete: true, dependencyFingerprint: originalA.dependencyFingerprint, exitCode: 1, passed: false });
    expect(failedA.output).toContain("intentional executor fault");
    expect(failedA.reusedFromRunId).toBeUndefined();
    expect(repairedA).toMatchObject({ dependencyComplete: true, dependencyFingerprint: originalA.dependencyFingerprint, exitCode: 0, passed: true });
    expect(repairedA.reusedFromRunId).toBeUndefined();
    expect(repairedA.durationMs).toBeGreaterThan(0);
    expect(f.database.listVerificationRuns(f.spec.id).find(run => run.id === locals[1]!.id)?.results.find(result => result.command === aCommand)?.exitCode).toBe(1);
  });

  it("stops between real suites on pause and resumes the saved completed suite without rerunning it", async () => {
    const f = await fixture({ pauseFirstSuite: true });
    const paused = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(paused.status, paused.text).toBe("paused");
    expect(f.commands).toEqual([bCommand]);
    const checkpoint = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(checkpoint.verificationProgress).toMatchObject({ stage: "local", results: [{ command: bCommand, exitCode: 0, passed: true }] });
    expect(checkpoint.verificationProgress?.pendingItemIds).toHaveLength(1);
    expect(checkpoint.verificationProgress?.codeFingerprint).toBeTruthy();
    expect(f.events.some(event => event.type === "result" && event.status === "completed")).toBe(false);
    f.resumeLocal();
    expectAccepted(f, await f.run(() => f.engine.resume(f.spec.id, f.profile)));
    expect(f.commands).toEqual([bCommand, aCommand, integrationCommand]);
    expect(f.database.getLatestCheckpoint(f.spec.id)?.verificationProgress).toBeUndefined();
    const local = f.database.listVerificationRuns(f.spec.id).find(run => run.stage === "local" && run.passed)!;
    expect(local.results).toHaveLength(2);
    expect(local.results.every(result => result.exitCode === 0 && result.passed && result.fingerprint)).toBe(true);
  });
});
