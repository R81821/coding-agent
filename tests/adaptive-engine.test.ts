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

const localCommand = "node --test test/local.test.mjs";
const integrationCommand = "node --test test/integration.test.mjs";
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 10000 });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const steps = [
  { id: "service", text: "Implement the service value", dependsOn: [], verification: [check(localCommand)] },
  { id: "caller", text: "Implement the caller value", dependsOn: [], verification: [check(localCommand)] },
];
const requirements = ["The service and caller export the requested value", "The caller composes with the service"];
const finalBody = "The service and caller are implemented. The local and integration test suites pass, and each requirement has current evidence.";
const analysisBody = "The service and caller each export zero. Both modules are independent and use the same value convention.";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Scenario = "merge" | "analysis" | "analysis-invalid" | "early-integration";

async function fixture(scenario: Scenario, invalidAcceptance?: "malformed" | "rejected") {
  const analysis = scenario === "analysis" || scenario === "analysis-invalid";
  const root = await mkdtemp(join(tmpdir(), "harness-adaptive-engine-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "service.mjs"), "export const service = 0;\n");
  await writeFile(join(workspace, "caller.mjs"), "export const caller = 0;\n");
  await writeFile(join(workspace, "test", "local.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { service } from "../service.mjs";',
    'import { caller } from "../caller.mjs";',
    'test("the service implements the requested value", () => assert.equal(service, 1));',
    'test("the caller implements the requested value", () => assert.equal(caller, 1));',
  ].join("\n"));
  await writeFile(join(workspace, "test", "integration.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { service } from "../service.mjs";',
    'import { caller } from "../caller.mjs";',
    // This invariant is valid for both the baseline and the completed implementation. The early
    // passing receipt must still expire when real edits change the repository fingerprint.
    'test("the caller and service compose consistently", () => {',
    '  assert.equal(caller, service);',
    '  assert.equal(caller + service, 2 * service);',
    '});',
  ].join("\n"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "adaptive-engine-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const commands: string[] = [];
  const states: WorkflowState[] = [];
  let latest: WorkflowState | undefined;
  let phase = "prepare";
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register(applyPatchTool);
  tools.register({ ...terminalTool, async execute(input, context) {
    commands.push(String(input.command));
    return terminalTool.execute(input, context);
  } });
  const model = descriptor({ providerId: "fake", modelId: "adaptive-engine", displayName: "Adaptive engine fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "review") throw new Error("Independent model reviews must not run");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "The adaptive scenario still lacks runtime acceptance." }; return;
      }
      if (phase === "prepare") {
        yield call("service-context", "read_file", { path: "service.mjs" });
        yield call("caller-context", "read_file", { path: "caller.mjs" });
        if (analysis) phase = "accept";
        else {
          yield action("configure", {
            action: "configure", summary: "Implement matching service and caller exports", requirements,
            architecture: "Two independent modules expose values that are composed by the caller",
            evidenceIds: ["service-context", "caller-context"], steps, integration: [check(integrationCommand)], startStepId: "service",
          });
          phase = scenario === "early-integration" ? "early-integration" : "merge";
        }
        return;
      }
      if (phase === "early-integration") {
        yield call("early-integration-suite", "run_verification", { ...check(integrationCommand), stage: "broader" });
        phase = "merge"; return;
      }
      if (phase === "merge") {
        // The independent caller can start before service verification. Both started steps are
        // implemented before one suite invocation verifies their combined code revision.
        yield action("start-caller", { action: "start_step", stepId: "caller" });
        for (const module of ["service", "caller"]) {
          yield call("patch-" + module, "patch", { patch: `--- a/${module}.mjs\n+++ b/${module}.mjs\n@@ -1 +1 @@\n-export const ${module} = 0;\n+export const ${module} = 1;\n` });
        }
        phase = "local"; return;
      }
      if (phase === "local") {
        yield call("combined-local-suite", "run_verification", check(localCommand));
        phase = scenario === "merge" ? "revise" : "integration"; return;
      }
      if (phase === "revise") {
        yield action("clarify-plan", {
          action: "update_plan", reason: "Clarify the implemented boundaries without changing tests or code",
          steps: [{ ...steps[1]!, text: "Expose the caller value" }, { ...steps[0]!, text: "Expose the service value" }],
        });
        // Final diff evidence is collected before broader verification. A complete unchanged
        // fingerprint can be reused after tests rather than forcing another repository read.
        yield call("accepted-diff", "workspace_diff", {});
        phase = "integration"; return;
      }
      if (phase === "integration") {
        yield call("final-integration-suite", "run_verification", { ...check(integrationCommand), stage: "broader" });
        phase = scenario === "merge" ? "accept" : "diff"; return;
      }
      if (phase === "diff") {
        yield call("accepted-diff", "workspace_diff", {});
        phase = "accept"; return;
      }
      if (phase === "accept") {
        if (!latest) throw new Error("The runtime must publish workflow state before acceptance");
        yield call("accept-requirements", "check_requirements", { evidence: latest.requirementIds.map(requirementId => ({
          requirementId,
          ...(invalidAcceptance === "malformed" ? {} : { summary: analysis ? "Both complete module reads support the analysis" : "Real local and integration suites cover the changed modules and their composition" }),
          observationIds: analysis ? ["service-context", "caller-context"] : ["accepted-diff"],
          ...(analysis ? {} : { verificationIds: [latest!.localCheck.runId, latest!.broaderCheck.runId], diffObservationId: "accepted-diff" }),
          passed: invalidAcceptance !== "rejected",
        })) });
        phase = "report"; return;
      }
      // Invalid-analysis scenarios deliberately keep repeating prose instead of repairing their
      // explicit failed acceptance. A final body cannot replace the missing runtime receipt.
      yield { type: "text_delta", delta: analysis ? analysisBody : finalBody };
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
  const spec: RunSpec = { id: newId("run"), sessionId: "adaptive-engine", request: analysis ? "Analyze the service and caller boundaries" : "Implement matching service and caller exports",
    workspacePath: workspace, taskMode: analysis ? "analysis" : "auto", profileId: profile.id,
    attachments: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: scenario === "analysis-invalid" ? 6 : 14, maxToolCalls: 48 }, grants: [] };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "workflow_updated") { latest = structuredClone(event.workflow); states.push(latest); }
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
  });
  async function run() {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Adaptive engine scenario timed out")); }, 25000);
      const onEvent = (event: AgentEvent) => {
        if (event.type !== "result") return;
        clearTimeout(timer); engine.off("event", onEvent); resolve(event);
      };
      engine.on("event", onEvent); engine.start(spec, profile);
    });
    await engine.waitForSettlement(spec.id);
    return result;
  }
  return { engine, database, spec, events, requests, commands, states, workspace, run, latest: () => latest };
}

function expectAcceptedOnce(f: Awaited<ReturnType<typeof fixture>>, result: Extract<AgentEvent, { type: "result" }>, body: string) {
  expect(result.status, JSON.stringify({ text: result.text, stop: result.stop, workflow: f.latest() })).toBe("completed");
  expect(f.requests.some(request => request.purpose === "review")).toBe(false);
  expect(f.latest()?.independentReview.status).toBe("skipped");
  expect(f.events.filter(event => event.type === "text_delta" && event.delta === body)).toHaveLength(1);
  expect(f.events.filter(event => event.type === "result")).toHaveLength(1);
  expect(f.events.find(event => event.sequence === result.sourceAssistantTurnSequence)?.type).toBe("assistant_turn_started");
  expect(f.events.filter(event => event.type === "tool_finished" && event.isError)).toEqual([]);
  expect(f.database.getLatestCheckpoint(f.spec.id)?.workflow?.requirementsRevision).toBe(f.latest()?.revision);
}

describe("adaptive planning through the real engine and persisted test suites", { timeout: 35000 }, () => {
  it("atomically configures independent steps, combines edits, retains checks across textual replanning, and accepts one final result", async () => {
    const f = await fixture("merge");
    const result = await f.run();
    expectAcceptedOnce(f, result, finalBody);
    expect((await readFile(join(f.workspace, "service.mjs"), "utf8")).replaceAll("\r\n", "\n")).toBe("export const service = 1;\n");
    expect((await readFile(join(f.workspace, "caller.mjs"), "utf8")).replaceAll("\r\n", "\n")).toBe("export const caller = 1;\n");
    expect(f.latest()?.sequential?.mode).toBe("adaptive");
    expect(f.latest()?.sequential?.steps.every(step => step.status === "verified" && step.check.revision === f.latest()?.revision)).toBe(true);
    const beforeReplan = f.states.find(state => state.sequential?.steps.length === steps.length && state.sequential.steps.every(step => step.status === "verified"));
    for (const step of f.latest()!.sequential!.steps) {
      const old = beforeReplan?.sequential?.steps.find(candidate => candidate.id === step.id);
      expect(old?.verificationKey).toBeTruthy();
      expect(step.verificationKey).toBe(old?.verificationKey);
      expect(step.check.runId).toBe(old?.check.runId);
    }
    expect(f.commands).toEqual([localCommand, integrationCommand]);
    const runs = f.database.listVerificationRuns(f.spec.id);
    expect(runs.map(run => run.stage).sort()).toEqual(["broader", "local"]);
    expect(runs.every(run => run.passed && run.results.length > 0 && run.results.every(item => item.exitCode === 0 && item.passed && !item.timedOut))).toBe(true);
    const local = runs.find(run => run.stage === "local")!;
    expect(local.results).toHaveLength(2);
    expect(local.results.filter(item => item.reusedFromItemId)).toHaveLength(1);
    expect(f.latest()?.requirementReceipts).toHaveLength(requirements.length);
    const diff = f.latest()?.observations.find(item => item.id === "accepted-diff");
    const broader = f.latest()?.observations.find(item => item.id === f.latest()?.broaderCheck.runId);
    expect(diff?.codeFingerprint).toBeTruthy();
    expect(diff!.sequence).toBeLessThan(broader!.sequence);
    expect(f.events.filter(event => event.type === "tool_started" && event.call.name === "workspace_diff")).toHaveLength(1);
    expect(f.events.some(event => event.type === "approval_required")).toBe(true);
  });

  it("accepts explicit analysis with complete read evidence and no test or diff references", async () => {
    const f = await fixture("analysis");
    const result = await f.run();
    expectAcceptedOnce(f, result, analysisBody);
    expect(f.commands).toEqual([]);
    expect(f.database.listVerificationRuns(f.spec.id)).toEqual([]);
    expect(f.latest()?.intent).toBe("analysis");
    expect(f.latest()?.revision).toBe(0);
    expect(f.latest()?.explicitRequirementAcceptance).toBe(true);
    expect(f.latest()?.requirementReceipts).toMatchObject([{ observationIds: ["service-context", "caller-context"], verificationIds: [], diffObservationId: "" }]);
    expect(f.events.some(event => event.type === "tool_started" && ["workspace_diff", "run_verification", "patch"].includes(event.call.name))).toBe(false);
  });

  it.each(["malformed", "rejected"] as const)("keeps %s explicit read-only acceptance unresolved despite repeated final prose", async invalidAcceptance => {
    const f = await fixture("analysis-invalid", invalidAcceptance);
    const result = await f.run();
    expect(result.status, JSON.stringify({ text: result.text, stop: result.stop, workflow: f.latest() })).toBe("review");
    expect(result.stop?.code).toBe("model_turn_limit");
    expect(f.events.some(event => event.type === "result" && event.status === "completed")).toBe(false);
    expect(f.events.filter(event => event.type === "tool_started" && event.call.name === "check_requirements")).toHaveLength(1);
    expect(f.events.find(event => event.type === "tool_finished" && event.callId === "accept-requirements")).toMatchObject({
      isError: true, output: { code: invalidAcceptance === "malformed" ? "requirement_input_invalid" : "requirement_gate_rejected" },
    });
    const finalWorkflow = f.database.getLatestCheckpoint(f.spec.id)?.workflow;
    expect(finalWorkflow).toMatchObject({
      explicitRequirementAcceptance: true, requirementsRevision: -1, requirementReceipts: [], revision: 0,
    });
    expect(f.latest()).toMatchObject({ explicitRequirementAcceptance: true, requirementsRevision: -1, requirementReceipts: [] });
    expect(f.database.getRun(f.spec.id)?.status).toBe("review");
    expect(f.commands).toEqual([]);
    expect(f.database.listVerificationRuns(f.spec.id)).toEqual([]);
    expect(f.requests.some(request => request.purpose === "review")).toBe(false);
    expect(f.events.some(event => event.type === "tool_started" && ["workspace_diff", "run_verification", "patch"].includes(event.call.name))).toBe(false);
    const recoveryMessages = f.requests.flatMap(request => request.messages).flatMap(message => message.content).flatMap(part => {
      if (part.type !== "text" || !part.text.startsWith("Untrusted verification output.") || !part.text.includes('"workingMemory"')) return [];
      try { return [JSON.parse(part.text.slice(part.text.indexOf("\n") + 1)) as { workingMemory?: { taskMode?: string; intent?: string }; nextAction?: string }]; }
      catch { return []; }
    }).filter(message => message.workingMemory?.taskMode === "analysis" && message.workingMemory.intent === "analysis");
    expect(recoveryMessages.length).toBeGreaterThan(0);
    expect(recoveryMessages.some(message => /read.only|current observations/i.test(message.nextAction ?? ""))).toBe(true);
    expect(recoveryMessages.every(message => !/use run_verification|rerun (?:required )?local|run (?:the )?(?:current )?local/i.test(message.nextAction ?? ""))).toBe(true);
  });

  it("allows early real integration testing but invalidates that receipt after writes and reruns before completion", async () => {
    const f = await fixture("early-integration");
    const result = await f.run();
    expectAcceptedOnce(f, result, finalBody);
    const runs = f.database.listVerificationRuns(f.spec.id);
    const broader = runs.filter(run => run.stage === "broader");
    expect(broader).toHaveLength(2);
    expect(broader.every(run => run.passed && run.results.every(item => item.exitCode === 0))).toBe(true);
    const initial = broader.find(run => run.revision === 0)!;
    const current = broader.find(run => run.revision === f.latest()?.revision)!;
    expect(initial).toBeDefined();
    expect(current).toBeDefined();
    expect(current.id).not.toBe(initial.id);
    expect(f.latest()?.broaderCheck.runId).toBe(current.id);
    expect(f.states.some(state => state.revision > 0 && state.broaderCheck.status === "pending")).toBe(true);
    expect(f.states.some(state => state.broaderCheck.runId === initial.id && state.sequential?.steps.some(step => step.status !== "verified") && state.requirementsRevision === -1)).toBe(true);
    expect(f.latest()?.requirementReceipts.every(receipt => receipt.verificationIds.includes(current.id) && !receipt.verificationIds.includes(initial.id))).toBe(true);
    expect(f.commands).toEqual([integrationCommand, localCommand, integrationCommand]);
  });
});
