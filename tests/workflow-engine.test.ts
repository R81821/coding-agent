import { applyContextDiff } from "../packages/core/src/prompt-cache.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { applyPatchTool, gitDiffTool } from "../packages/tools/src/builtins.js";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type RunSpec, type WorkflowState } from "@harness/protocol";
import { terminalTool, ToolRegistry } from "@harness/tools";
import { workflowCall, workflowPrelude, workflowReadTool } from "./workflow-fixture.js";

async function runScenario(mode: "pass" | "local-failure" | "broader-failure" | "review-failure" | "early-done" | "reedit" | "no-verification" | "timeout" | "dynamic-verification" | "denied-verification" | "check-budget" | "outside-check" | "independent-pass" | "independent-fail" | "independent-malformed" | "independent-tool-call" | "broader-required" | "broader-optional" | "broader-disabled" | "deep-failure" | "probe-before-script" | "five-failures" | "real-probe" | "resume-repairs" | "late-verification" | "final-without-verification") {
  const root = await mkdtemp(join(tmpdir(), "harness-workflow-"));
  if (mode === "real-probe") {
    await promisify(execFileCallback)("git", ["init", "-q", root]);
    // The fixture keeps its database inside the workspace; a WAL database also writes `-wal`/`-shm`
    // beside it, and those sidecars are large binary untracked files that would make the real
    // git_diff report a truncated observation forever. Exclude the database and everything SQLite
    // derives from it.
    await writeFile(join(root, ".git", "info", "exclude"), "db.sqlite*\nkey.json\nskills/\n");
  }
  const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-passphrase");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  try {
    const checks: string[] = []; let mutations = 0; let turn = 0; let failedOnce = false; let reviewFailed = false; let last: WorkflowState | undefined; let reviews = 0; let localFailures = 0;
    const model = descriptor({ providerId: "fake", modelId: "workflow", displayName: "Workflow", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        if (request.messages.some(message => message.content.some(part => part.type === "text" && part.text.startsWith("Independent read-only final review")))) {
          reviews += 1;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        let runtimeState: unknown;
        for (const message of request.messages) for (const part of message.content) {
          if (part.type !== "text" || !part.text.startsWith("Trusted runtime context")) continue;
          const frame = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1));
          runtimeState = frame.kind === "base_snapshot" ? frame.snapshot : applyContextDiff(runtimeState, frame.dirtyDiff);
        }
        if (runtimeState) last = (runtimeState as { workingMemory: WorkflowState }).workingMemory;
        turn += 1;
        if (turn <= 3) {
          const events = workflowPrelude(turn);
          if (mode === "dynamic-verification" && turn === 3) for (const event of events) if (event.type === "tool_call" && event.toolCall) event.toolCall.input.verification = [{ stage: "local", command: "fixture local" }, { stage: "broader", command: "fixture broader" }];
          yield* events; return;
        }
        if (mode === "final-without-verification" && turn === 5) { yield { type: "text_delta", delta: "Probe passed; done." }; return; }
        if (mode === "early-done" || (mode === "timeout" && mutations > 0)) { yield { type: "text_delta", delta: "Looks done." }; return; }
        const state = last!;
        if (["probe-before-script", "real-probe"].includes(mode) && turn === 4) { yield workflowCall("probe", "terminal", { command: "fixture probe" }); return; }
        if (state.diagnosisRequired) {
          const chain = state.failureChains.find(item => item.id === state.activeChainId);
          const fresh = state.observations.find(item => item.epoch === state.epoch && item.sequence > (chain?.lastSequence ?? 0) && item.tool === "read_file" && !item.failed);
          if (chain && chain.count >= 2 && !fresh) { yield workflowCall("reread-" + turn, "read_file", { path: "src/value.ts" }); return; }
          const expanded = state.observations.find(item => item.epoch === state.epoch && item.sequence > (chain?.lastSequence ?? 0) && item.tool === "search_text" && !item.failed);
          if (chain && chain.count >= 3 && !expanded) { yield workflowCall("search-" + turn, "search_text", { query: "boundary callers" }); return; }
          yield workflowCall(`diagnose-${turn}`, "update_workflow", { action: "diagnose", context: "Failure evidence identifies an unhandled boundary", steps: ["Fix boundary and rerun tests"], cause: `Boundary case needs correction ${turn}`, evidenceIds: [state.activeFailureId, ...(fresh ? [fresh.id] : []), ...(expanded ? [expanded.id] : [])], ...(expanded ? { alternatives: ["wrong caller", "wrong condition"], experiment: { question: "Which layer handles null?", expectedResults: ["caller handles", "callee handles"], observationIds: [expanded.id] } } : {}) }); return;
        }
        if (mutations === 0 || (state.phase === "update_hypothesis") || (mode === "reedit" && state.reviewedRevision === 1)) {
          yield workflowCall(`patch-${turn}`, "apply_patch", { patch: mode === "real-probe" ? "diff --git a/probe.js b/probe.js\nnew file mode 100644\n--- /dev/null\n+++ b/probe.js\n@@ -0,0 +1 @@\n+export const value = 42;\n" : mode.startsWith("independent") ? "+++ b/src/auth.ts\n-old\n+new" : "+++ b/src/value.ts\n-old\n+new" }); return;
        }
        if (state.localCheck?.status !== "passed" || state.localCheck.revision !== state.revision || state.broaderCheck?.status === "pending") {
          yield workflowCall(`verify-${turn}`, "update_workflow", { action: "request_verification", ...(["late-verification", "final-without-verification"].includes(mode) && turn >= 6 ? { verification: [{ stage: "local", command: "fixture local" }, { stage: "broader", command: "fixture broader" }] } : {}) }); return;
        }
        if (state.diffRevision !== state.revision) { yield workflowCall(`diff-${turn}`, "git_diff", {}); return; }
        if (state.requirementsRevision !== state.revision) {
          yield workflowCall(`requirements-${turn}`, "update_workflow", { action: "requirements", passed: true, evidence: [{ requirementId: state.requirementIds[0], summary: "The configured tests verify the target and compatibility", observationIds: [state.observations.findLast(item => item.tool === "git_diff")!.id], verificationIds: [state.localCheck.runId], diffObservationId: state.observations.findLast(item => item.tool === "git_diff")!.id }] }); return;
        }
        if (state.reviewedRevision !== state.revision) {
          const reject = mode === "review-failure" && !reviewFailed; reviewFailed ||= reject;
          yield workflowCall(`review-${turn}`, "update_workflow", { action: "review", passed: !reject, evidenceIds: [state.observations.findLast(item => item.tool === "git_diff")!.id], summary: reject ? "Missing edge case" : "Diff is scoped; requirements, regressions and edge cases checked" }); return;
        }
        yield { type: "text_delta", delta: "Implemented and verified with reviewed diff." };
      },
    };
    const tools = new ToolRegistry().register(workflowReadTool).register({ ...workflowReadTool, contract: { ...workflowReadTool.contract, name: "search_text", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }).register({
      contract: { ...workflowReadTool.contract, name: "apply_patch", risk: "write", idempotent: false, inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
      async execute(input, context) { mutations += 1; if (mode === "real-probe") return applyPatchTool.execute(input, context); return { output: { applied: true } }; },
    }).register({ contract: { ...workflowReadTool.contract, name: "git_diff", inputSchema: { type: "object", properties: {} } }, async execute(input, context) { if (mode === "real-probe") return gitDiffTool.execute(input, context); return { output: { diff: "-old\n+new" } }; } }).register({
      ...terminalTool, async execute(input) {
        const command = String(input.command); checks.push(command);
        if (mode === "real-probe" && command !== "fixture probe") expect((await readFile(join(root, "probe.js"), "utf8")).trim()).toBe("export const value = 42;");
        const shouldFail = (["deep-failure", "five-failures", "resume-repairs"].includes(mode) && command === "fixture local" && localFailures < (["five-failures", "resume-repairs"].includes(mode) ? 5 : 3)) || !failedOnce && ((mode === "local-failure" && command === "fixture local") || (mode === "broader-failure" && command === "fixture broader"));
        if (shouldFail) { failedOnce = true; localFailures += 1; }
        return { output: { exitCode: shouldFail ? 1 : 0, stdout: "test output", stderr: shouldFail ? "FAILED value: boundary mismatch" : "", timedOut: mode === "timeout" }, isError: shouldFail };
      },
    });
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "search_text", "apply_patch", "git_diff", "terminal"], verificationPolicy: { maxRepairAttempts: mode === "deep-failure" ? 4 : 2, broaderPolicy: mode === "broader-required" ? "required" as const : mode === "broader-disabled" ? "disabled" as const : "optional" as const, reviewPolicy: mode.startsWith("independent") ? "risk_based" as const : "standard" as const, items: ["no-verification", "dynamic-verification", "late-verification", "final-without-verification"].includes(mode) ? [] : (["local", "broader"] as const).filter(stage => !["broader-optional", "broader-required"].includes(mode) || stage === "local").map(stage => ({ id: stage, stage, command: `fixture ${stage}`, cwd: mode === "outside-check" ? ".." : ".", timeoutMs: 1000, required: true, expectedExitCodes: [0] })) } };
    const run: RunSpec = { workflowVersion: 1, id: newId("run"), sessionId: "workflow", request: "Fix value without changing compatibility", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxTurns: ["five-failures", "resume-repairs"].includes(mode) ? 64 : 40, maxToolCalls: mode === "check-budget" ? 6 : 128 }, grants: [{ toolNames: mode === "denied-verification" ? ["apply_patch"] : ["apply_patch", "terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture"], networkDomains: [], maxRisk: "high" }], createdAt: nowIso() };
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((done, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("workflow fixture timed out")); }, 15000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "workflow_updated") last = event.workflow;
        if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "fixture"), 0);
        if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, false, "fixture"), 0);
        if (mode === "resume-repairs" && event.type === "repair_started" && event.attempt === 5) engine.pause(run.id);
        if (event.type === "result") { clearTimeout(timer); done(event); }
      });
      engine.start(run, profile);
    });
    await engine.waitForSettlement(run.id);
    if (mode === "resume-repairs") {
      expect(result.status).toBe("paused");
      const prior = database.getLatestCheckpoint(run.id)!;
      expect(prior.repairAttemptsUsed).toBe(5);
      // Simulate a legacy checkpoint: recover the count from repair_started events.
      delete prior.repairAttemptsUsed;
      database.saveCheckpoint(prior);
      const resumed = new Promise<Extract<AgentEvent, {type:"result"}>>(done => {
        const listener = (event: AgentEvent) => { if (event.type === "result") { engine.off("event", listener); done(event); } };
        engine.on("event", listener);
      });
      engine.resume(run.id, profile);
      const resumedResult = await resumed;
      expect(resumedResult.status, resumedResult.text).toBe("completed");
      await engine.waitForSettlement(run.id);
    }
    return { result, checks, mutations, reviews, verificationRuns: database.listVerificationRuns(run.id), events: database.listEvents(run.id), checkpoint: database.getLatestCheckpoint(run.id) };
  } finally {
    database.close(); vault.dispose(); const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup target");
    await rm(root, { recursive: true, force: true });
  }
}

describe("real engine workflow", () => {
  it.each(["late-verification", "final-without-verification"] as const)("recovers %s in the same run without treating configuration as a code failure", async mode => {
    const result = await runScenario(mode);
    expect(result.result.status, JSON.stringify(result.result.stop)).toBe("completed");
    expect(result.checks).toEqual(["fixture local", "fixture broader"]);
    expect(result.mutations).toBe(1);
    expect(result.checkpoint?.repairAttemptsUsed).toBe(0);
    expect(result.checkpoint?.workflow?.failures).toBe(0);
    expect(result.verificationRuns.every(run => run.outcome === "passed")).toBe(true);
  });
  it("creates a real probe with a null-sentinel patch before running verification", async () => {
    const result = await runScenario("real-probe");
    expect(result.result.status, JSON.stringify({stop:result.result.stop,errors:result.events.filter(e => e.type === "tool_finished" && e.isError)})).toBe("completed");
    expect(result.checks).toEqual(["fixture probe", "fixture local", "fixture broader"]);
    expect(result.events.some(e => e.type === "tool_finished" && e.isError)).toBe(false);
  });
  it("preserves repair counts across resume including legacy checkpoints", async () => {
    const result = await runScenario("resume-repairs");
    expect(result.checkpoint?.repairAttemptsUsed).toBe(5);
    expect(result.events.filter(e => e.type === "repair_started")).toHaveLength(5);
  });
  it("does not validate before a probe script is created", async () => {
    const result = await runScenario("probe-before-script");
    expect(result.result.status).toBe("completed");
    const firstCheck = result.events.findIndex(e => e.type === "verification_started");
    const patch = result.events.findIndex(e => e.type === "tool_started" && e.call.name === "apply_patch");
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(firstCheck).toBeGreaterThan(patch);
    expect(result.checks).toEqual(["fixture probe", "fixture local", "fixture broader"]);
  });
  it("allows five repairs with model and tool budget remaining", async () => {
    const result = await runScenario("five-failures");
    expect(result.result.status).toBe("completed");
    expect(result.mutations).toBe(6);
    const repairs = result.events.filter(e => e.type === "repair_started");
    expect(repairs).toHaveLength(5);
    expect(repairs.every(e => e.type === "repair_started" && e.maxAttempts === null)).toBe(true);
    expect(result.checkpoint?.repairAttemptsUsed).toBe(5);
  });
  it("executes ordered local/broader checks and only completes after requirements and diff review", async () => {
    const result = await runScenario("pass");
    expect(result.result.status).toBe("completed"); expect(result.checks).toEqual(["fixture local", "fixture broader"]);
    const phases = result.events.flatMap(e => e.type === "workflow_updated" ? [e.workflow.phase] : []);
    expect(phases).toEqual(expect.arrayContaining(["task_understanding", "repository_recon", "build_working_context", "plan_hypothesis", "small_edit", "local_verification", "inspect_result", "broader_verification", "requirements_check", "final_review", "done"]));
    expect(phases.indexOf("small_edit")).toBeLessThan(phases.indexOf("local_verification"));
    expect(result.checkpoint?.workflow?.reviewedRevision).toBe(1);
    expect(result.verificationRuns.every(run => run.outcome === "passed")).toBe(true);
    expect(result.events.filter(e => e.type === "verification_finished").every(e => e.type === "verification_finished" && e.verification.outcome === "passed")).toBe(true);
  });
  it.each(["local-failure", "broader-failure", "review-failure"] as const)("diagnoses and repairs %s before completing", async mode => {
    const result = await runScenario(mode);
    expect(result.result.status).toBe("completed"); expect(result.mutations).toBe(2);
    expect(result.events.some(e => e.type === "workflow_updated" && e.workflow.phase === "update_hypothesis")).toBe(true);
    if (mode !== "review-failure") expect(result.verificationRuns.some(run => run.outcome === "failed" && !run.passed)).toBe(true);
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
    expect(result.checkpoint?.toolCalls).toBeLessThanOrEqual(6);
    expect(result.result.stop?.code).toBe("tool_call_limit");
  });
  it.each(["independent-pass", "independent-fail", "independent-malformed", "independent-tool-call"] as const)("ignores the retired reviewer in %s while preserving legacy requirements and review", async mode => {
    const result = await runScenario(mode); expect(result.result.status).toBe("completed");
    expect(result.reviews).toBe(0);
    expect(result.mutations).toBe(1);
    expect(result.checkpoint?.workflow?.independentReview.status).toBe("skipped");
    expect(result.checkpoint?.workflow?.requirementsRevision).toBe(result.checkpoint?.workflow?.revision);
    expect(result.checkpoint?.workflow?.reviewedRevision).toBe(result.checkpoint?.workflow?.revision);
    expect(result.checks).toEqual(["fixture local", "fixture broader"]);
  });
  it.each(["broader-optional", "broader-disabled"] as const)("records %s as skipped, never passed", async mode => {
    const result = await runScenario(mode); expect(result.result.status).toBe("completed"); expect(result.checks).toEqual(["fixture local"]);
    expect(result.checkpoint?.workflow?.broaderCheck.status).toBe("skipped"); expect(result.checkpoint?.workflow?.broaderRevision).toBe(-1);
    expect(result.events.some(event => event.type === "verification_finished" && event.verification.stage === "broader" && event.verification.passed === false && event.verification.outcome === "skipped")).toBe(true);
  });
  it("does not complete if required broader verification has no configured items", async () => {
    const result = await runScenario("broader-required"); expect(result.result.status).toBe("review"); expect(result.checkpoint?.workflow?.broaderCheck.status).toBe("pending");
    expect(result.checkpoint?.repairAttemptsUsed).toBe(0);
    expect(result.verificationRuns).toEqual([]);
  });
  it("requires expanded search and experiment evidence before repairing a third recurring failure", async () => {
    const result = await runScenario("deep-failure"); expect(result.result.status).toBe("completed"); expect(result.mutations).toBe(4);
    expect(result.checkpoint?.workflow?.hypotheses.at(-1)?.alternatives).toHaveLength(2);
    expect(result.checkpoint?.workflow?.hypotheses.at(-1)?.experiment?.observationIds[0]).toMatch(/^search-/);
    expect(result.checkpoint?.workflow?.failureChains.filter(item => item.source.startsWith("verification")).every(item => item.status === "resolved")).toBe(true);
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
