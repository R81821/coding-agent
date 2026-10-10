import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { AgentEventSchema, DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { applyPatchTool, createDefaultToolRegistry, terminalTool, ToolRegistry } from "@harness/tools";
import { summarizeVerificationReuse, type VerificationReuseSummary } from "../packages/core/src/verification-reuse.js";

const aCommand = "node --test test/a.test.mjs";
const bCommand = "node --test test/b.test.mjs";
const integrationCommand = "node --test test/integration.test.mjs";
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 10000 });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const patch = (id: string, module: "a" | "b", before: number, after: number) => call(id, "patch", {
  patch: `--- a/${module}.mjs\n+++ b/${module}.mjs\n@@ -1 +1 @@\n-export const ${module} = ${before};\n+export const ${module} = ${after};\n`,
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function scenario(mode: "normal" | "forced" | "later-failure") {
  const directory = await mkdtemp(join(tmpdir(), "harness-verification-cache-engine-"));
  const workspace = join(directory, "repo");
  await mkdir(join(workspace, "test"), { recursive: true });
  for (const module of ["a", "b"]) {
    await writeFile(join(workspace, `${module}.mjs`), `export const ${module} = 0;\n`);
    await writeFile(join(workspace, "test", `${module}.test.mjs`), [
      'import { test } from "node:test";', 'import assert from "node:assert/strict";',
      `import { ${module} } from "../${module}.mjs";`, `test("${module} is implemented", () => assert.equal(${module}, 1));`,
    ].join("\n") + "\n");
  }
  await writeFile(join(workspace, "test", "integration.test.mjs"), [
    'import { test } from "node:test";', 'import assert from "node:assert/strict";',
    'import { a } from "../a.mjs";', 'import { b } from "../b.mjs";',
    'test("values compose", () => assert.equal(a + b, 2));',
  ].join("\n") + "\n");
  const vault = await VaultCrypto.open(join(directory, "key.json"), "verification-cache-engine-fixture-password");
  const database = await HarnessDatabase.open(join(directory, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const commands: string[] = [];
  let latest: WorkflowState | undefined;
  let phase = "prepare";
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!).register(applyPatchTool);
  tools.register({ ...terminalTool, async execute(input, context) {
    commands.push(String(input.command));
    return terminalTool.execute(input, context);
  } });
  const model = descriptor({ providerId: "fake", modelId: "verification-cache-engine", displayName: "Verification cache fixture", capabilities: {
    vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local",
  } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      if (request.purpose === "review") throw new Error("Independent model review must remain disabled");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "Current verification remains incomplete." }; return;
      }
      if (phase === "prepare") {
        yield call("read-a", "read_file", { path: "a.mjs" });
        yield call("read-b", "read_file", { path: "b.mjs" });
        yield action("configure", {
          action: "configure", summary: "Implement independent a and b values", requirements: ["Both values equal one and compose correctly"],
          architecture: "a and b are independent modules", evidenceIds: ["read-a", "read-b"],
          steps: [
            { id: "a", text: "Implement a", priority: 90, dependsOn: [], verification: [check(aCommand)] },
            { id: "b", text: "Implement b", priority: 10, dependsOn: [], verification: [check(bCommand)] },
          ], integration: [check(integrationCommand)],
        });
        yield action("select-a", { action: "select_next" });
        phase = "implement-a"; return;
      }
      if (phase === "implement-a") { yield patch("patch-a", "a", 0, 1); phase = "a-local"; return; }
      if (phase === "a-local") { yield call("verify-a", "run_verification", check(aCommand)); phase = "implement-b"; return; }
      if (phase === "implement-b") { yield patch("patch-b", "b", 0, 1); phase = "b-local"; return; }
      if (phase === "b-local") {
        yield call("verify-b", "run_verification", { ...check(bCommand), ...(mode === "forced" ? { force: true } : {}) });
        phase = mode === "later-failure" ? "break-a" : "integration"; return;
      }
      if (phase === "break-a") {
        yield action("reopen-a", { action: "reopen_step", stepId: "a", reason: "Exercise a genuine test failure after receipt reuse" });
        yield patch("regress-a", "a", 1, 0);
        phase = "failed-local"; return;
      }
      if (phase === "failed-local") { yield call("verify-regression", "run_verification", check(aCommand)); phase = "repair-a"; return; }
      if (phase === "repair-a") { yield patch("repair-a", "a", 0, 1); phase = "repaired-local"; return; }
      if (phase === "repaired-local") { yield call("verify-repair", "run_verification", check(aCommand)); phase = "integration"; return; }
      if (phase === "integration") {
        yield call("verify-integration", "run_verification", { ...check(integrationCommand), stage: "broader" });
        phase = "diff"; return;
      }
      if (phase === "diff") { yield call("current-diff", "workspace_diff", {}); phase = "accept"; return; }
      if (phase === "accept") {
        if (!latest) throw new Error("Workflow state is required for acceptance");
        yield call("accept-requirements", "check_requirements", { evidence: latest.requirementIds.map(requirementId => ({
          requirementId, summary: "Real persisted local and integration suites cover both values and their composition",
          observationIds: ["current-diff"], verificationIds: [latest!.localCheck.runId, latest!.broaderCheck.runId], diffObservationId: "current-diff", passed: true,
        })) });
        phase = "report"; return;
      }
      yield { type: "text_delta", delta: "Both values are implemented and the actual local and integration suites pass." };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database),
    skills: new SkillService(join(directory, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(async () => {
    await engine.close(); database.close(); vault.dispose();
    const path = relative(tmpdir(), directory);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Unsafe fixture cleanup target");
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "apply_patch", "terminal"], verificationPolicy: {
    ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled",
  } };
  const spec: RunSpec = { id: newId("run"), sessionId: "verification-cache-engine", request: "Implement independent a and b values and composition",
    workspacePath: workspace, taskMode: "auto", profileId: profile.id, attachments: [], grants: [], createdAt: nowIso(),
    budget: { ...profile.budget, maxTurns: 24, maxToolCalls: 80 } };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "workflow_updated") latest = structuredClone(event.workflow);
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
  });
  const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
    const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Verification cache engine scenario timed out")); }, 25000);
    engine.on("event", (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); resolve(event); } });
    engine.start(spec, profile);
  });
  await engine.waitForSettlement(spec.id);
  return { result, events, commands, database, spec };
}

type DecisionEvent = Extract<AgentEvent, { type: "verification_cache_decision" }>;
function decisions(events: AgentEvent[]) { return events.filter((event): event is DecisionEvent => event.type === "verification_cache_decision"); }
function measurement(events: AgentEvent[], callId: string) {
  const event = events.find(event => event.type === "tool_finished" && event.callId === callId);
  return event?.type === "tool_finished" ? (event.output as { reuseMeasurement?: VerificationReuseSummary }).reuseMeasurement : undefined;
}

describe("verification cache measurement through actual persisted test execution", { timeout: 35000 }, () => {
  it("persists explicit execution misses and unchanged dependency receipt hits with provenance", async () => {
    const f = await scenario("normal");
    expect(f.result.status, JSON.stringify(f.result)).toBe("completed");
    expect(f.commands).toEqual([aCommand, bCommand, integrationCommand]);
    const localRuns = f.database.listVerificationRuns(f.spec.id).filter(run => run.stage === "local").sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
    expect(localRuns).toHaveLength(2);
    const telemetry = decisions(f.database.listEvents(f.spec.id));
    for (const event of telemetry) expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(telemetry.find(event => event.verificationRunId === localRuns[0]!.id && event.command === aCommand)).toMatchObject({ cached: false, source: "executed", reason: "no_saved_receipt", dependencyComplete: true });
    expect(telemetry.find(event => event.verificationRunId === localRuns[1]!.id && event.command === aCommand)).toMatchObject({ cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: localRuns[0]!.id, dependencyComplete: true });
    expect(telemetry.filter(event => event.command === aCommand)).toHaveLength(2);
    expect(measurement(f.events, "verify-b")).toMatchObject({ cacheHits: 1, failureAfterReuse: false });
    expect(summarizeVerificationReuse(f.database.listEvents(f.spec.id), f.spec.id).reusedFromRunIds).toContain(localRuns[0]!.id);
  });

  it("records force=true as a fresh execution miss rather than a saved receipt hit", async () => {
    const f = await scenario("forced");
    expect(f.result.status, JSON.stringify(f.result)).toBe("completed");
    expect(f.commands).toEqual([aCommand, aCommand, bCommand, integrationCommand]);
    const telemetry = decisions(f.database.listEvents(f.spec.id));
    expect(telemetry.filter(event => event.command === aCommand).at(-1)).toMatchObject({ cached: false, source: "executed", force: true, reason: "forced" });
    expect(telemetry.some(event => event.cached)).toBe(false);
    expect(measurement(f.events, "verify-b")).toMatchObject({ cacheHits: 0, forcedItems: 2 });
  });

  it("retains an actual later assertion failure after cache reuse in the same run even after repair", async () => {
    const f = await scenario("later-failure");
    expect(f.result.status, JSON.stringify(f.result)).toBe("completed");
    const failure = f.database.listVerificationRuns(f.spec.id).find(run => !run.passed && run.results.some(result => result.exitCode === 1));
    expect(failure?.runId).toBe(f.spec.id);
    expect(failure?.results.find(result => result.command === aCommand)).toMatchObject({ passed: false, exitCode: 1 });
    const summary = summarizeVerificationReuse(f.database.listEvents(f.spec.id), f.spec.id);
    expect(summary).toMatchObject({ failureAfterReuse: true, runsWithCacheHits: 1, runsWithFailureAfterReuse: 1 });
    expect(summary.items.find(item => item.cached && item.command === aCommand)).toMatchObject({ failureAfterReuse: true, sameItemFailureAfterReuse: true });
    expect(measurement(f.events, "verify-regression")).toMatchObject({ failureAfterReuse: true });
    expect(measurement(f.events, "verify-repair")).toMatchObject({ failureAfterReuse: true });
  });

});
