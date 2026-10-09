import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { createDefaultToolRegistry, terminalTool, ToolRegistry } from "@harness/tools";

const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const localCommand = "node --test test/local.test.mjs";
const integrationCommand = "node --test test/integration.test.mjs";
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 10000 });

interface AcceptanceScenario {
  acceptance?: "missing" | "missing-verification" | "stale-verification" | "stale-diff" | "failed-requirement" | "partial-requirements" | "repair-stale-evidence";
  generationPolicy?: Profile["generationPolicy"];
  reviewPolicy?: "standard" | "risk_based";
  rejectInline?: boolean;
  maxTurns?: number;
  maxToolCalls?: number;
}

async function scenario(mode: "pass" | "repair" | "repair-test" | "denied" | "budget" | "pause" | "failed-tests" | "cancel", options: AcceptanceScenario = {}) {
  const directory = await mkdtemp(join(tmpdir(), "harness-sequential-"));
  const workspace = join(directory, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  await writeFile(join(workspace, "service.ts"), "export const service = 0;\n");
  await writeFile(join(workspace, "caller.ts"), "export const caller = 0;\n");
  await mkdir(join(workspace, "test"));
  await writeFile(join(workspace, "test", "local.test.mjs"), [
    'import { readFileSync } from "node:fs";', 'import { test } from "node:test";', 'import assert from "node:assert/strict";',
    'test("service is implemented", () => assert.match(readFileSync("service.ts", "utf8"), /= 1;/));',
    'test("caller exposes a nonnegative numeric value", () => assert.match(readFileSync("caller.ts", "utf8"), /= [0-9]+;/));',
  ].join("\n"));
  const integrationTest = (callerValue: number) => [
    'import { readFileSync } from "node:fs";', 'import { test } from "node:test";', 'import assert from "node:assert/strict";',
    'test("service and caller agree", () => {',
    '  assert.match(readFileSync("service.ts", "utf8"), /= 1;/);',
    `  assert.match(readFileSync("caller.ts", "utf8"), /= ${callerValue};/);`,
    '});',
  ].join("\n");
  await writeFile(join(workspace, "test", "integration.test.mjs"), integrationTest(mode === "repair-test" ? 2 : 1));
  const vault = await VaultCrypto.open(join(directory, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(directory, "db.sqlite"), vault);
  let engine: HarnessEngine | undefined;
  try {
    const events: AgentEvent[] = [];
    const requests: ModelRequest[] = [];
    let reviewAttempts = 0;
    const executed: string[] = [];
    const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
    tools.register({ contract: { name: "edit_test", description: "Correct an erroneous integration expectation", inputSchema: { type: "object", properties: {} }, risk: "write", idempotent: false, timeoutMs: 1000 },
      async execute() { executed.push("edit:test"); await writeFile(join(workspace, "test", "integration.test.mjs"), integrationTest(1)); return { output: "Corrected caller expectation; both service and caller assertions retained" }; } });
    tools.register({ contract: { name: "edit_module", description: "fixture implementation", inputSchema: { type: "object", properties: { module: { type: "string", enum: ["service", "caller"] } }, required: ["module"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
      async execute(input) { const name = String(input.module); const value = name === "caller" && (mode === "failed-tests" || mode === "repair" && !executed.includes("edit:caller")) ? 2 : 1; executed.push("edit:" + name); await writeFile(join(workspace, name + ".ts"), `export const ${name} = ${value};\n`); return { output: "updated " + name }; } });
    tools.register({ ...terminalTool,
      async execute(input, context) {
        const command = String(input.command); executed.push(command);
        return terminalTool.execute(input, context);
      } });
    tools.register({ contract: { name: "git_diff", description: "fixture complete diff", inputSchema: { type: "object", properties: {} }, risk: "read", idempotent: true, timeoutMs: 1000 }, async execute() { executed.push("diff"); return { output: { diff: "service.ts and caller.ts: -value=0 +value=1", complete: true } }; } });
    tools.register({ contract: { name: "browser", description: "fixture browser screenshot", inputSchema: { type: "object", properties: {} }, risk: "read", idempotent: true, timeoutMs: 1000 }, async execute() { return { output: { tabId: "built-in-tab", url: "file:///service.html", screenshot: { mimeType: "image/png", path: "fixture.png" } } }; } });
    const steps = [ { id: "service", text: "Implement service", verification: [check(localCommand)] }, { id: "caller", text: "Wire caller", verification: [check(localCommand)] } ];
    let turn = 0;
    let latest: WorkflowState | undefined;
    let phase = "initial";
    let repaired = false;
    let resumed = false;
    let acceptanceAttempts = 0;
    const model = descriptor({ providerId: "fake", modelId: "sequential", displayName: "Sequential", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) {
        requests.push(request);
        if (request.purpose === "review") {
          reviewAttempts++;
          // A provider that cannot review must not affect completion now that real tests own validation.
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
          yield { type: "text_delta", delta: "Current test evidence remains incomplete." }; return;
        }
        turn++;
        if (turn === 1) {
          // None of these calls may execute a mutation or skip the preparation gate.
          yield call("early-write", "edit_module", { module: "service" });
          yield call("early-probe", "probe", { command: "echo forbidden" });
          yield call("early-check", "run_verification", check(localCommand));
          yield action("understand", { action: "understand", summary: "Implement service and connect caller", requirements: options.acceptance === "partial-requirements" ? ["Service and caller work together", "Preserve the caller boundary"] : ["Service and caller work together"] });
          yield call("recon", "read_file", { path: "service.ts" });
          yield action("architecture", { action: "architecture", summary: "service owns logic and caller composes it", evidenceIds: ["recon"] });
          yield action("plan", { action: "plan", steps, integration: [check(integrationCommand)] });
          yield action("skip-step", { action: "start_step", stepId: "caller" });
          yield action("start-service", { action: "start_step", stepId: "service" });
          phase = "service"; return;
        }
        if (resumed && latest?.sequential?.architectureEpoch !== latest?.epoch) {
          yield call("resume-recon", "read_file", { path: "service.ts" });
          yield action("resume-architecture", { action: "architecture", summary: "Rechecked the service and caller boundary", evidenceIds: ["resume-recon"] });
          yield action("resume-service", { action: "start_step", stepId: "service" });
          phase = "service"; return;
        }
        if (phase === "service") {
          yield call("edit-service-" + turn, "edit_module", { module: "service" });
          yield call("verify-service-" + turn, "run_verification", check(localCommand));
          phase = "caller"; return;
        }
        if (phase === "caller") {
          yield action("start-caller-" + turn, { action: "start_step", stepId: "caller" });
          yield call("edit-caller-" + turn, "edit_module", { module: "caller" });
          yield call("verify-caller-" + turn, "run_verification", check(localCommand));
          phase = "integration"; return;
        }
        if (phase === "integration" && mode !== "budget") {
          if (mode === "cancel") { engine!.cancel(request.runId); return; }
          if (options.rejectInline) {
            yield call("inline-node", "run_verification", { ...check('node -e "process.exit(0)"'), stage: "broader" });
            yield call("inline-stdin", "run_verification", { ...check("node -"), stage: "broader", stdin: "process.exit(0)" });
          }
          yield call("early-diff", "git_diff", {});
          yield call("foreign-check", "run_verification", { ...check("unplanned-integration"), stage: "broader" });
          yield call("integration-" + turn, "run_verification", { ...check(integrationCommand), stage: "broader" });
          phase = "finish"; return;
        }
        if ((mode === "repair" || mode === "repair-test") && latest?.broaderCheck.status !== "passed" && !repaired) {
          repaired = true;
          yield action("reopen", { action: "reopen_step", stepId: "caller", reason: mode === "repair-test" ? "The integration test has an incorrect caller expectation" : "Integration exposed a caller mismatch" });
          yield call("repair-caller", mode === "repair-test" ? "edit_test" : "edit_module", mode === "repair-test" ? {} : { module: "caller" });
          yield call("reverify-caller", "run_verification", check(localCommand));
          yield call("integration-retry", "run_verification", { ...check(integrationCommand), stage: "broader" });
          return;
        }
        if (phase === "finish" && latest?.broaderCheck.status === "passed" && latest.diffRevision !== latest.revision) { yield call("final-diff", "git_diff", {}); return; }
        if (phase === "finish" && latest?.broaderCheck.status === "passed" && latest.requirementsRevision !== latest.revision && options.acceptance !== "missing") {
          acceptanceAttempts++;
          const diff = latest.observations.findLast(item => item.tool === "git_diff" && item.revision === latest!.revision && !item.failed)!;
          const previousLocal = events.find(event => event.type === "verification_finished" && event.verification.stage === "local");
          const receipt = {
            requirementId: latest.requirementIds[0], summary: "Both local tests and the integration suite pass; the complete diff connects service and caller.",
            observationIds: [diff.id],
            verificationIds: options.acceptance === "missing-verification" ? [] : [(options.acceptance === "stale-verification" || options.acceptance === "repair-stale-evidence" && acceptanceAttempts === 1) && previousLocal?.type === "verification_finished" ? previousLocal.verification.id : latest.localCheck.runId, latest.broaderCheck.runId],
            diffObservationId: options.acceptance === "stale-diff" ? "early-diff" : diff.id,
            passed: options.acceptance !== "failed-requirement",
          };
          yield call("accept-requirements-" + turn, "check_requirements", { evidence: [receipt] });
          // Invalid receipts must never be repaired by merely repeating a final answer.
          if (options.acceptance && options.acceptance !== "repair-stale-evidence") phase = "rejected-acceptance";
          return;
        }
        yield { type: "text_delta", delta: "Service and caller result; any missing checks remain unverified." };
      },
    };
    engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(directory, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = { ...DEFAULT_PROFILE, ...(options.generationPolicy ? { generationPolicy: options.generationPolicy } : {}), allowedProviders: ["fake"], toolNames: ["read_file", "edit_module", "edit_test", "terminal", "git_diff", "browser"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled", ...(options.reviewPolicy ? { reviewPolicy: options.reviewPolicy } : {}) } };
    const spec: RunSpec = { id: newId("run"), sessionId: "sequential", request: "Implement service and wire caller", workspacePath: workspace, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxTurns: options.maxTurns ?? (mode === "budget" || mode === "denied" ? 9 : 24), ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}) }, grants: [{ toolNames: ["edit_module", "edit_test"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write" }], createdAt: nowIso() };
    engine.on("event", (event: AgentEvent) => {
      events.push(event);
      if (event.type === "workflow_updated") latest = event.workflow;
      if (event.type === "plan_approval_required") setTimeout(() => engine!.decidePlan(event.planId, event.version, true, "fixture"), 0);
      if (event.type === "approval_required") setTimeout(() => engine!.approvals.decide(event.approvalId, mode !== "denied", "fixture"), 0);
      if (mode === "pause" && !resumed && event.type === "workflow_updated" && event.workflow.sequential?.steps[0]?.status === "verified") engine!.pause(spec.id);
    });
    const run = async (start: () => void) => {
      const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
        const timer = setTimeout(() => { engine!.cancel(spec.id); reject(new Error("Sequential test timed out")); }, 20000);
        const onEvent = (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); engine!.off("event", onEvent); resolve(event); } };
        engine!.on("event", onEvent); start();
      });
      await engine!.waitForSettlement(spec.id);
      return result;
    };
    let result = await run(() => engine!.start(spec, profile));
    if (mode === "pause") { expect(result.status, result.text).toBe("paused"); resumed = true; result = await run(() => engine!.resume(spec.id, profile)); }
    return { result, events, executed, latest, requests, reviewAttempts, acceptanceAttempts, storedSpec: database.getRun(spec.id)?.spec, toolCalls: database.getLatestCheckpoint(spec.id)?.toolCalls, finalCaller: await readFile(join(workspace, "caller.ts"), "utf8"), finalTest: await readFile(join(workspace, "test", "integration.test.mjs"), "utf8") };
  } finally {
    await engine?.close(); database.close(); vault.dispose();
    const path = relative(tmpdir(), directory);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Unsafe cleanup target");
    await rm(directory, { recursive: true, force: true });
  }
}

describe("default sequential loop through the actual engine and bridge", { timeout: 30000 }, () => {
  it.each([undefined, "standard", "risk_based"] as const)("uses test acceptance without a reviewer when Profile review is %s", async reviewPolicy => {
    const result = await scenario("pass", reviewPolicy ? { reviewPolicy } : {});
    expect(result.result.status).toBe("completed");
    expect(result.reviewAttempts).toBe(0);
    expect(result.latest?.independentReview.status).toBe("skipped");
    expect(result.latest?.requirementReceipts).toHaveLength(1);
    expect(result.latest?.requirementsRevision).toBe(result.latest?.revision);
    expect(result.requests.filter(request => request.purpose === "review")).toHaveLength(0);
    expect(result.result.sourceAssistantTurnSequence).toBeDefined();
  });
  it("emits the accepted final body once without a review timeout or second summary", async () => {
    const result = await scenario("pass");
    expect(result.result.status).toBe("completed");
    expect(result.result.text).toContain("Service and caller result");
    expect(result.reviewAttempts).toBe(0);
    expect(result.requests.filter(request => request.messages.some(message => message.runtimePrompt === "stop_summary"))).toHaveLength(0);
    expect(result.events.filter(event => event.type === "text_delta" && event.delta.includes("Service and caller result"))).toHaveLength(1);
    expect(result.events.filter(event => event.type === "result")).toHaveLength(1);
    const source = result.events.find(event => event.sequence === result.result.sourceAssistantTurnSequence);
    expect(source?.type).toBe("assistant_turn_started");
  });
  it("respects the main output limit without consuming the legacy review allowance", async () => {
    const result = await scenario("pass", { generationPolicy: { maxOutputTokens: 4096, reviewMaxOutputTokens: 8192 } });
    expect(result.reviewAttempts).toBe(0);
    expect(result.requests.filter(request => request.purpose === "main").every(request => request.maxOutputTokens <= 4096)).toBe(true);
    expect(result.result.status).toBe("completed");
  });
  it("completes when the accepted report consumes the last model turn", async () => {
    const baseline = await scenario("pass");
    const result = await scenario("pass", { maxTurns: baseline.requests.length });
    expect(result.result.status, JSON.stringify({ stop: result.result.stop, requests: result.requests.length, latest: { requirementsRevision: result.latest?.requirementsRevision, reviewedRevision: result.latest?.reviewedRevision, revision: result.latest?.revision }, text: result.result.text })).toBe("completed");
    expect(result.requests).toHaveLength(baseline.requests.length);
    expect(result.reviewAttempts).toBe(0);
  });
  it("reports normally after acceptance consumes the last tool call", async () => {
    const baseline = await scenario("pass");
    expect(baseline.toolCalls).toBeGreaterThan(0);
    if (baseline.toolCalls === undefined) throw new Error("The baseline run must persist its actual tool-call count.");
    const result = await scenario("pass", { maxToolCalls: baseline.toolCalls });
    expect(result.result.status, JSON.stringify(result.result.stop)).toBe("completed");
    expect(result.toolCalls).toBe(baseline.toolCalls);
    expect(result.requests.filter(request => request.messages.some(message => message.runtimePrompt === "stop_summary"))).toHaveLength(0);
    expect(result.reviewAttempts).toBe(0);
  });
  it.each(["missing", "missing-verification", "stale-verification", "stale-diff", "failed-requirement", "partial-requirements"] as const)("continues requesting repair for %s until the budget ends instead of accepting unsupported prose", async acceptance => {
    const result = await scenario("pass", { acceptance, maxTurns: 10 });
    expect(result.result.status).toBe("review");
    expect(result.result.stop?.code).toBe("model_turn_limit");
    expect(result.latest?.requirementsRevision).not.toBe(result.latest?.revision);
    expect(result.reviewAttempts).toBe(0);
    if (acceptance !== "missing") expect(result.events.some(event => event.type === "tool_finished" && event.callId.startsWith("accept-requirements-") && event.isError)).toBe(true);
    expect(result.result.stop?.pending).not.toContain("独立评审");
  });
  it("enforces ordered steps, cumulative checks, integration and final diff review", async () => {
    const result = await scenario("pass");
    expect(result.result.status).toBe("completed");
    expect(result.executed).toEqual(["edit:service", localCommand, "edit:caller", localCommand, "diff", integrationCommand, "diff"]);
    expect(result.storedSpec?.workflowVersion).toBe(3);
    expect(result.latest?.sequential?.steps.map(step => step.status)).toEqual(["verified", "verified"]);
    expect(result.latest?.independentReview.status).toBe("skipped");
    expect(result.latest?.requirementReceipts[0]?.verificationIds).toEqual([result.latest?.localCheck.runId, result.latest?.broaderCheck.runId]);
    const local = result.events.findLast(event => event.type === "verification_finished" && event.verification.stage === "local");
    expect(local?.type === "verification_finished" && local.verification.results).toMatchObject([
      { command: localCommand, passed: true },
      { command: localCommand, passed: true, durationMs: 0, reusedFromItemId: expect.any(String) },
    ]);
    const errors = result.events.filter(event => event.type === "tool_finished" && event.isError).map(event => event.type === "tool_finished" ? event.callId : "");
    expect(errors).toContain("skip-step"); expect(errors).toContain("foreign-check");
    expect(result.events.filter(event => event.type === "tool_started").map(event => event.type === "tool_started" && event.call.id)).not.toContain("early-write");
  });
  it("repairs an integration failure before test acceptance", async () => {
    const result = await scenario("repair");
    expect(result.result.status).toBe("completed");
    expect(result.executed.filter(command => command === integrationCommand)).toHaveLength(2);
    expect(result.events.filter(event => event.type === "verification_finished" && !event.verification.passed)).toHaveLength(1);
    expect(result.executed.filter(command => command === localCommand)).toHaveLength(3);
    expect(result.latest?.requirementReceipts[0]?.verificationIds).toContain(result.latest?.broaderCheck.runId);
    expect(result.reviewAttempts).toBe(0);
  });
  it("repairs a stale receipt with current evidence and keeps the actual passing suites", async () => {
    const result = await scenario("pass", { acceptance: "repair-stale-evidence" });
    expect(result.result.status).toBe("completed");
    expect(result.acceptanceAttempts).toBe(2);
    expect(result.events.filter(event => event.type === "tool_finished" && event.callId.startsWith("accept-requirements-") && event.isError)).toHaveLength(1);
    expect(result.executed.filter(command => command === localCommand)).toHaveLength(2);
    expect(result.executed.filter(command => command === integrationCommand)).toHaveLength(1);
    expect(result.latest?.requirementReceipts[0]?.verificationIds).toEqual([result.latest?.localCheck.runId, result.latest?.broaderCheck.runId]);
    expect(result.reviewAttempts).toBe(0);
  });
  it("corrects a faulty test expectation and reruns both suites with the useful assertions retained", async () => {
    const result = await scenario("repair-test");
    expect(result.result.status).toBe("completed");
    expect(result.executed.filter(command => command === "edit:test")).toHaveLength(1);
    expect(result.executed.filter(command => command === "edit:caller")).toHaveLength(1);
    expect(result.executed.filter(command => command === integrationCommand)).toHaveLength(2);
    expect(result.executed.filter(command => command === localCommand)).toHaveLength(3);
    expect(result.events.filter(event => event.type === "verification_finished" && !event.verification.passed)).toHaveLength(1);
    expect(result.finalCaller).toBe("export const caller = 1;\n");
    expect(result.finalTest).toContain('assert.match(readFileSync("service.ts", "utf8"), /= 1;/)');
    expect(result.finalTest).toContain('assert.match(readFileSync("caller.ts", "utf8"), /= 1;/)');
    expect(result.latest?.requirementReceipts[0]?.verificationIds).toEqual([result.latest?.localCheck.runId, result.latest?.broaderCheck.runId]);
  });
  it("rejects inline assertions and stdin scripts then continues with the file based suites", async () => {
    const result = await scenario("pass", { rejectInline: true });
    expect(result.result.status).toBe("completed");
    for (const callId of ["inline-node", "inline-stdin"]) {
      const event = result.events.find(item => item.type === "tool_finished" && item.callId === callId);
      expect(event).toMatchObject({ isError: true });
      expect(JSON.stringify(event)).toContain("verification_file_required");
    }
    expect(result.executed.filter(command => command === localCommand)).toHaveLength(2);
    expect(result.executed.filter(command => command === integrationCommand)).toHaveLength(1);
    expect(result.executed.some(command => command.includes("process.exit") || command === "node -")).toBe(false);
    expect(result.events.filter(event => event.type === "verification_finished")).toHaveLength(3);
    expect(result.latest?.requirementReceipts[0]?.verificationIds).toEqual([result.latest?.localCheck.runId, result.latest?.broaderCheck.runId]);
  });
  it("keeps requesting repairs after failing integration tests until the model budget ends", async () => {
    const result = await scenario("failed-tests", { maxTurns: 9 });
    expect(result.result.status).toBe("review");
    expect(result.result.stop?.code).toBe("model_turn_limit");
    expect(result.latest?.broaderCheck.status).toBe("failed");
    expect(result.latest?.requirementReceipts).toEqual([]);
    expect(result.reviewAttempts).toBe(0);
  });
  it("cancels without requesting a reviewer", async () => {
    const result = await scenario("cancel");
    expect(result.result.status).toBe("cancelled");
    expect(result.reviewAttempts).toBe(0);
  });
  it("keeps denied verification and exhausted budgets incomplete", async () => {
    for (const mode of ["denied", "budget"] as const) {
      const result = await scenario(mode);
      expect(result.result.status).toBe("review");
      expect(result.latest?.independentReview.status).not.toBe("passed");
      if (mode === "denied") expect(result.executed).not.toContain(localCommand);
      else expect(result.result.stop?.pending).toContain("集成测试");
    }
  });
  it("resumes an unchanged workspace with the verified step, architecture and real test receipt preserved", async () => {
    const result = await scenario("pause");
    expect(result.result.status).toBe("completed");
    const paused = result.events.find(event => event.type === "result" && event.status === "paused");
    if (!paused) throw new Error("The scenario must pause after verifying its first step");
    const beforeResume = result.events.findLast(event => event.type === "workflow_updated" && event.sequence < paused.sequence);
    const afterResume = result.events.find(event => event.type === "workflow_updated" && event.sequence > paused.sequence);
    if (beforeResume?.type !== "workflow_updated" || afterResume?.type !== "workflow_updated") throw new Error("Both checkpoint and restored workflow state must be published");
    expect(afterResume.workflow.epoch).toBe(beforeResume.workflow.epoch);
    expect(afterResume.workflow.requirements).toEqual(beforeResume.workflow.requirements);
    expect(afterResume.workflow.requirementIds).toEqual(beforeResume.workflow.requirementIds);
    expect(afterResume.workflow.sequential?.architectureEpoch).toBe(beforeResume.workflow.sequential?.architectureEpoch);
    expect(afterResume.workflow.sequential?.evidenceIds).toEqual(beforeResume.workflow.sequential?.evidenceIds);
    expect(afterResume.workflow.sequential?.steps).toEqual(beforeResume.workflow.sequential?.steps);
    expect(afterResume.workflow.sequential?.steps[0]?.status).toBe("verified");
    expect(afterResume.workflow.localCheck).toEqual(beforeResume.workflow.localCheck);
    expect(result.events.find(event => event.type === "verification_finished" && event.verification.id === afterResume.workflow.localCheck.runId)).toMatchObject({
      type: "verification_finished", verification: { stage: "local", passed: true, outcome: "passed", results: [{ exitCode: 0, passed: true, timedOut: false }] },
    });
    const epochs = new Set(result.events.flatMap(event => event.type === "workflow_updated" ? [event.workflow.epoch] : []));
    expect(epochs.size).toBe(1);
    // Caller changes invalidate cumulative checks, so its local suite runs again; service itself
    // must not be rewritten/retested merely because this trusted unchanged checkpoint resumed.
    expect(result.executed).toEqual(["edit:service", localCommand, "edit:caller", localCommand, "diff", integrationCommand, "diff"]);
    expect(result.events.some(event => event.type === "tool_started" && event.call.id === "resume-recon")).toBe(false);
    expect(result.latest?.sequential?.steps.map(step => step.status)).toEqual(["verified", "verified"]);
    expect(result.latest?.requirementReceipts).toHaveLength(1);
  });
});
