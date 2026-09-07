import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type RunSpec, type WorkflowState } from "@harness/protocol";
import { terminalTool, ToolRegistry } from "@harness/tools";
import { workflowCall, workflowPrelude, workflowReadTool } from "./workflow-fixture.js";

async function runScenario(mode: "pass" | "local-failure" | "broader-failure" | "review-failure" | "early-done" | "reedit" | "no-verification" | "timeout" | "dynamic-verification" | "denied-verification" | "check-budget" | "outside-check") {
  const root = await mkdtemp(join(tmpdir(), "harness-workflow-"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-passphrase");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  try {
    const checks: string[] = []; let mutations = 0; let turn = 0; let failedOnce = false; let reviewFailed = false; let last: WorkflowState | undefined;
    const model = descriptor({ providerId: "fake", modelId: "workflow", displayName: "Workflow", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const runtime = request.messages.flatMap(message => message.content.flatMap(part => part.type === "text" && part.text.startsWith("Trusted runtime context") ? [part.text] : [])).at(-1);
        if (runtime) last = JSON.parse(runtime.slice(runtime.indexOf("\n") + 1)).workingMemory;
        turn += 1;
        if (turn <= 3) {
          const events = workflowPrelude(turn);
          if (mode === "dynamic-verification" && turn === 3) for (const event of events) if (event.type === "tool_call" && event.toolCall) event.toolCall.input.verification = [{ stage: "local", command: "fixture local" }, { stage: "broader", command: "fixture broader" }];
          yield* events; return;
        }
        if (mode === "early-done" || (mode === "timeout" && mutations > 0)) { yield { type: "text_delta", delta: "Looks done." }; return; }
        const state = last!;
        if (state.diagnosisRequired) {
          yield workflowCall(`diagnose-${turn}`, "update_workflow", { action: "diagnose", context: "Failure evidence identifies an unhandled boundary", steps: ["Fix boundary and rerun tests"], cause: `Boundary case needs correction ${turn}`, evidenceIds: ["recon"] }); return;
        }
        if (mutations === 0 || (state.phase === "update_hypothesis") || (mode === "reedit" && state.reviewedRevision === 1)) {
          yield workflowCall(`patch-${turn}`, "apply_patch", { patch: "+++ b/src/value.ts\n-old\n+new" }); return;
        }
        if (state.diffRevision !== state.revision) { yield workflowCall(`diff-${turn}`, "git_diff", {}); return; }
        if (state.requirementsRevision !== state.revision) {
          yield workflowCall(`requirements-${turn}`, "update_workflow", { action: "requirements", passed: true, evidence: ["The configured tests verify the target and compatibility"] }); return;
        }
        if (state.reviewedRevision !== state.revision) {
          const reject = mode === "review-failure" && !reviewFailed; reviewFailed ||= reject;
          yield workflowCall(`review-${turn}`, "update_workflow", { action: "review", passed: !reject, summary: reject ? "Missing edge case" : "Diff is scoped; requirements, regressions and edge cases checked" }); return;
        }
        yield { type: "text_delta", delta: "Implemented and verified with reviewed diff." };
      },
    };
    const tools = new ToolRegistry().register(workflowReadTool).register({
      contract: { ...workflowReadTool.contract, name: "apply_patch", risk: "write", idempotent: false, inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
      async execute() { mutations += 1; return { output: { applied: true } }; },
    }).register({ contract: { ...workflowReadTool.contract, name: "git_diff", inputSchema: { type: "object", properties: {} } }, async execute() { return { output: { diff: "-old\n+new" } }; } }).register({
      ...terminalTool, async execute(input) {
        const command = String(input.command); checks.push(command);
        const shouldFail = !failedOnce && ((mode === "local-failure" && command === "fixture local") || (mode === "broader-failure" && command === "fixture broader"));
        if (shouldFail) failedOnce = true;
        return { output: { exitCode: shouldFail ? 1 : 0, stdout: "test output", stderr: shouldFail ? "FAILED value: boundary mismatch" : "", timedOut: mode === "timeout" }, isError: shouldFail };
      },
    });
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "apply_patch", "git_diff", "terminal"], verificationPolicy: { maxRepairAttempts: 2, items: ["no-verification", "dynamic-verification"].includes(mode) ? [] : (["local", "broader"] as const).map(stage => ({ id: stage, stage, command: `fixture ${stage}`, cwd: mode === "outside-check" ? ".." : ".", timeoutMs: 1000, required: true, expectedExitCodes: [0] })) } };
    const run: RunSpec = { id: newId("run"), sessionId: "workflow", request: "Fix value without changing compatibility", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxTurns: 40, maxToolCalls: mode === "check-budget" ? 5 : 64 }, grants: [{ toolNames: mode === "denied-verification" ? ["apply_patch"] : ["apply_patch", "terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture"], networkDomains: [], maxRisk: "high" }], createdAt: nowIso() };
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((done, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("workflow fixture timed out")); }, 15000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "workflow_updated") last = event.workflow;
        if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "fixture"), 0);
        if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, false, "fixture"), 0);
        if (event.type === "result") { clearTimeout(timer); done(event); }
      });
      engine.start(run, profile);
    });
    await new Promise<void>(done => setImmediate(done));
    return { result, checks, mutations, events: database.listEvents(run.id), checkpoint: database.getLatestCheckpoint(run.id) };
  } finally {
    database.close(); vault.dispose(); const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup target");
    await rm(root, { recursive: true, force: true });
  }
}

describe("real engine workflow", () => {
  it("executes ordered local/broader checks and only completes after requirements and diff review", async () => {
    const result = await runScenario("pass");
    expect(result.result.status).toBe("completed"); expect(result.checks).toEqual(["fixture local", "fixture broader"]);
    const phases = result.events.flatMap(e => e.type === "workflow_updated" ? [e.workflow.phase] : []);
    expect(phases).toEqual(expect.arrayContaining(["task_understanding", "repository_recon", "build_working_context", "plan_hypothesis", "small_edit", "local_verification", "inspect_result", "broader_verification", "requirements_check", "final_review", "done"]));
    expect(phases.indexOf("small_edit")).toBeLessThan(phases.indexOf("local_verification"));
    expect(result.checkpoint?.workflow?.reviewedRevision).toBe(1);
  });
  it.each(["local-failure", "broader-failure", "review-failure"] as const)("diagnoses and repairs %s before completing", async mode => {
    const result = await runScenario(mode);
    expect(result.result.status).toBe("completed"); expect(result.mutations).toBe(2);
    expect(result.events.some(e => e.type === "workflow_updated" && e.workflow.phase === "update_hypothesis")).toBe(true);
    if (mode === "local-failure") expect(result.checks).toEqual(["fixture local", "fixture local", "fixture broader"]);
    else expect(result.checks).toEqual(["fixture local", "fixture broader", "fixture local", "fixture broader"]);
  });
  it("executes task-proposed verification without a preconfigured Profile matrix", async () => {
    const result = await runScenario("dynamic-verification"); expect(result.result.status).toBe("completed");
    expect(result.checks).toEqual(["fixture local", "fixture broader"]);
    expect(result.checkpoint?.workflow?.verification).toHaveLength(2);
  });
  it.each(["denied-verification", "outside-check"] as const)("never executes %s commands", async mode => {
    const result = await runScenario(mode); expect(result.result.status).toBe("review"); expect(result.checks).toEqual([]);
  });
  it("charges verification against tool budget and leaves incomplete work in review", async () => {
    const result = await runScenario("check-budget"); expect(result.result.status).toBe("review"); expect(result.checks).toEqual(["fixture local"]);
    expect(result.checkpoint?.toolCalls).toBeLessThanOrEqual(5);
  });
  it("reruns both verification levels when the model edits after review", async () => {
    const result = await runScenario("reedit"); expect(result.result.status).toBe("completed"); expect(result.mutations).toBe(2);
    expect(result.checks).toEqual(["fixture local", "fixture broader", "fixture local", "fixture broader"]);
  });
  it.each(["early-done", "no-verification", "timeout"] as const)("does not complete with %s", async mode => {
    const result = await runScenario(mode); expect(result.result.status).toBe("review");
    expect(result.events.some(e => e.type === "workflow_updated" && e.workflow.phase === "done")).toBe(false);
    if (mode === "timeout") expect(result.checks).not.toContain("fixture broader");
  });
});