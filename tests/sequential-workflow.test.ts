import { describe, expect, it } from "vitest";
import { nowIso, WorkflowStateSchema, type VerificationRun } from "@harness/protocol";
import type { ToolDefinition } from "@harness/tools";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const writer: ToolDefinition = { contract: { name: "patch", description: "patch", inputSchema: {}, risk: "write", idempotent: false, timeoutMs: 1000 }, async execute() { return { output: {} }; } };
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 1000 });
function prepare(w = new SequentialWorkflow("Add a service and its caller", () => {}, undefined, {}, "change")) {
  w.advance({ action: "understand", summary: "Add the service and wire the caller", requirements: ["Service works", "Caller uses service"] });
  inspect(w);
  w.advance({ action: "architecture", summary: "service.ts owns logic; caller.ts composes it", evidenceIds: ["recon"] });
  w.advance({ action: "plan", mode: "ordered", steps: [
    { id: "service", text: "Implement service", verification: [check("unit-service")] },
    { id: "caller", text: "Wire caller", verification: [check("unit-caller")] },
  ], integration: [check("test-service-caller")] });
  return w;
}
function inspect(w: SequentialWorkflow, id = "recon") {
  w.observe({ id, name: "read_file", input: { path: "service.ts" } }, { output: "service source" });
}
function receipt(w: SequentialWorkflow, stage: "local" | "broader" = "local", passed = true): VerificationRun {
  return { id: "verify-" + Math.random(), runId: "run", attempt: 0, stage, epoch: w.state.epoch, revision: w.state.revision,
    passed, outcome: passed ? "passed" : "failed", startedAt: nowIso(), finishedAt: nowIso(),
    results: w.plannedChecks().filter(item => item.stage === stage).map(item => ({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: passed ? 0 : 1, passed, required: true, output: passed ? "Tests passed" : "Assertion failed", durationMs: 1, timedOut: false })),
  };
}
function finishStep(w: SequentialWorkflow, stepId: string) {
  w.advance({ action: "start_step", stepId });
  w.applyEffect({ kind: "repository_write", changedFiles: [stepId + ".ts"] });
  w.recordVerification(receipt(w));
}
function accept(w: SequentialWorkflow, overrides: Record<string, unknown> = {}) {
  const diff = w.state.observations.findLast(item => ["git_diff", "workspace_diff"].includes(item.tool))!;
  w.acceptRequirements(w.state.requirementIds.map(requirementId => ({ requirementId, summary: "Service and caller behavior are covered by the passing test suites", observationIds: [diff.id], verificationIds: [w.state.localCheck.runId, w.state.broaderCheck.runId], diffObservationId: diff.id, passed: true, ...overrides })));
}

describe("sequential implementation gates", () => {
  it("requires understanding, current repository evidence, architecture and a plan before writes", () => {
    const w = new SequentialWorkflow("Implement", () => {});
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toContain("workflow_preparation_required");
    expect(w.needsChange).toBe(true);
    inspect(w, "too-early");
    w.advance({ action: "understand", summary: "Implement service", requirements: ["Service works"] });
    expect(() => w.advance({ action: "architecture", summary: "architecture", evidenceIds: ["invented"] })).toThrow(/fresh/);
    expect(() => w.advance({ action: "plan", steps: [{ id: "one", text: "one", verification: [check("test")] }], integration: [check("integration")] })).toThrow(/identify architecture/);
    expect(() => w.advance({ action: "architecture", summary: "architecture", evidenceIds: ["too-early"] })).not.toThrow();
    prepare(w);
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toContain("workflow_step_required");
    w.advance({ action: "start_step", stepId: "service" });
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toBeUndefined();
  });

  it("does not accept failed, truncated, old revision or non-repository architecture evidence", () => {
    for (const kind of ["failed", "truncated", "stale", "non-repository"]) {
      const w = new SequentialWorkflow("Implement", () => {});
      w.advance({ action: "understand", summary: "Implement", requirements: ["Works"] });
      w.observe({ id: "bad", name: kind === "non-repository" ? "git_diff" : "read_file", input: {} }, { output: "source", ...(kind === "failed" ? { isError: true } : {}), ...(kind === "truncated" ? { truncated: true } : {}) });
      if (kind === "stale") w.applyEffect({ kind: "repository_write", changedFiles: ["a.ts"] });
      expect(() => w.advance({ action: "architecture", summary: "architecture", evidenceIds: ["bad"] })).toThrow(/fresh/);
    }
  });

  it("blocks skipped steps, fabricated receipts and failed checks, then permits repair", () => {
    const w = prepare();
    expect(() => w.advance({ action: "start_step", stepId: "caller" })).toThrow(/previous step/);
    w.advance({ action: "start_step", stepId: "service" });
    w.recordVerification({ ...receipt(w), results: [] });
    expect(() => w.advance({ action: "start_step", stepId: "caller" })).toThrow(/previous step/);
    w.recordVerification(receipt(w, "local", false));
    expect(w.state.sequential?.steps[0]?.status).toBe("in_progress");
    expect(w.verificationGate("broader")).toContain("all implementation steps");
    w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] });
    w.recordVerification(receipt(w));
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toContain("workflow_step_required");
    w.advance({ action: "start_step", stepId: "caller" });
    expect(w.plannedChecks().filter(item => item.stage === "local").map(item => item.command)).toEqual(["unit-service", "unit-caller"]);
  });

  it("requires integration followed by fresh diff and test-backed requirement acceptance", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.observe({ id: "early-diff", name: "git_diff", input: {} }, { output: "diff" });
    expect(w.state.diffRevision).toBe(w.state.revision);
    expect(w.checksCurrent()).toBe(false);
    w.recordVerification(receipt(w, "broader"));
    expect(w.checksCurrent()).toBe(true);
    expect(() => accept(w)).toThrow(/after its passing test suites/);
    w.acceptFinalReport("Done");
    expect(w.baseCanFinish()).toBe(false);
    w.observe({ id: "final-diff", name: "git_diff", input: {} }, { output: "complete diff" });
    w.acceptFinalReport("Service and caller verified");
    expect(w.baseCanFinish()).toBe(false);
    expect(w.canFinish()).toBe(false);
    accept(w);
    expect(w.state.requirementsRevision).toBe(w.state.revision);
    expect(w.state.reviewedRevision).toBe(-1);
    w.acceptFinalReport("Service and caller verified");
    expect(w.canFinish()).toBe(true);
    expect(w.requiresIndependentReview).toBe(false);
    expect(w.state.independentReview.status).toBe("skipped");
  });
  it("names a missing planned check even when an unrelated command passed", () => {
    const w = prepare();
    w.advance({ action: "start_step", stepId: "service" });
    const run = receipt(w);
    run.results = run.results.map(result => ({ ...result, command: "different-test" }));
    w.recordVerification(run);
    expect(run.passed).toBe(false);
    expect(run.outcome).toBe("failed");
    expect(run.skipReason).toContain("unit-service");
    expect(w.state.localCheck.status).toBe("failed");
    expect(w.state.localCheck.reason).toContain("Planned verification evidence is missing");
    expect(w.state.localCheck.reason).toContain("unit-service");
    expect(w.state.sequential?.steps[0]?.status).toBe("in_progress");
    expect(w.checksCurrent()).toBe(false);
  });
  it("accepts equivalent result cwd without changing the planned command or id", () => {
    const w = prepare();
    w.advance({ action: "start_step", stepId: "service" });
    const run = receipt(w);
    w.recordVerification({ ...run, results: run.results.map(result => ({ ...result, cwd: "./" })) });
    expect(w.state.localCheck.status).toBe("passed");
    expect(w.state.sequential?.steps[0]?.status).toBe("verified");
    expect(w.plannedChecks().find(item => item.stage === "local")).toMatchObject({ command: "unit-service", cwd: "." });
  });
  it.each(["command", "itemId", "passed"] as const)("keeps a receipt failed when its %s does not satisfy the plan", field => {
    const w = prepare();
    w.advance({ action: "start_step", stepId: "service" });
    const run = receipt(w);
    const invalid = { command: "unit-service ", itemId: "invented-item", passed: false };
    w.recordVerification({ ...run, results: run.results.map(result => ({ ...result, [field]: invalid[field] })) });
    expect(w.state.localCheck.status).toBe("failed");
    expect(w.state.localCheck.reason).toContain("unit-service");
    expect(w.state.sequential?.steps[0]?.status).toBe("in_progress");
  });
  it("bounds missing-check feedback while keeping the actual pass downgraded", () => {
    const w = prepare();
    const commands = Array.from({ length: 10 }, (_, index) => `node --test test/missing-${index}-${"x".repeat(330)}.test.mjs`);
    w.advance({ action: "plan", mode: "adaptive", reason: "Add per-boundary regression coverage", steps: commands.map((command, index) => ({ id: `bounded-${index}`, text: "Verify boundary " + index, verification: [check(command)] })), integration: [check("integration")] });
    for (let index = 0; index < commands.length; index++) w.advance({ action: "start_step", stepId: `bounded-${index}` });
    w.recordVerification({ ...receipt(w), results: [] });
    expect(w.state.localCheck.status).toBe("failed");
    expect(w.state.localCheck.reason).toContain("missing-0-");
    expect(w.state.localCheck.reason).toContain("missing-7-");
    expect(w.state.localCheck.reason).not.toContain("missing-8-");
    expect(w.state.localCheck.reason).not.toContain(commands[0]);
    expect(w.state.localCheck.reason.length).toBeLessThan(2700);
  });

  it("reruns tests after an integration failure without reopening code that needs no edit", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader", false));
    expect(w.checksCurrent()).toBe(false);
    expect(w.verificationGate("local")).toBeUndefined();
    w.recordVerification(receipt(w, "local"));
    w.recordVerification(receipt(w, "broader"));
    expect(w.state.sequential?.steps.map(step => step.status)).toEqual(["verified", "verified"]);
    expect(w.checksCurrent()).toBe(true);
    expect(w.canFinish()).toBe(false);
  });

  it("reopens a failed integration/review and invalidates the chosen step and successors", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader", false));
    expect(w.checksCurrent()).toBe(false);
    expect(w.nextAction()).toContain("reopen_step");
    w.advance({ action: "reopen_step", stepId: "service", reason: "integration found wrong service behavior" });
    expect(w.state.sequential?.steps.map(step => step.status)).toEqual(["in_progress", "pending"]);
    expect(() => w.advance({ action: "start_step", stepId: "caller" })).toThrow();
  });

  it("repairs a failed integration suite, reruns tests and completes with refreshed acceptance evidence", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader", false));
    expect(w.canFinish()).toBe(false);
    expect(w.nextAction()).toContain("repair and reverify");
    const requirements = [...w.state.requirements];
    w.advance({ action: "reopen_step", stepId: "caller", reason: "Diagnosed integration failure: fix caller mapping and add the boundary regression in its test file" });
    w.applyEffect({ kind: "repository_write", changedFiles: ["caller.ts", "caller.test.ts"] });
    w.recordVerification(receipt(w, "local"));
    w.recordVerification(receipt(w, "broader"));
    w.observe({ id: "repaired-diff", name: "workspace_diff", input: {} }, { output: "complete repaired code and test diff" });
    accept(w);
    w.acceptFinalReport("Caller mapping fixed; regression and integration suites passed");
    expect(w.canFinish()).toBe(true);
    expect(w.state.requirements).toEqual(requirements);
    expect(w.state.independentReview.status).toBe("skipped");
  });

  it("preserves current verification when requirement acceptance is rejected and requests correction", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader"));
    w.observe({ id: "final-diff", name: "workspace_diff", input: {} }, { output: "complete diff" });
    accept(w); w.acceptFinalReport("Service and caller verified");
    const verified = w.snapshot();
    const feedback = "Missing code evidence for caller behavior";
    expect(() => accept(w, { passed: false, summary: feedback })).toThrow(feedback);

    expect(w.state.localCheck).toEqual(verified.localCheck);
    expect(w.state.broaderCheck).toEqual(verified.broaderCheck);
    expect(w.state.diffRevision).toBe(verified.diffRevision);
    expect(w.state.sequential?.steps).toEqual(verified.sequential?.steps);
    expect(w.state.requirements).toEqual(verified.requirements);
    expect(w.state.plan).toEqual(verified.plan);
    expect(w.checksCurrent()).toBe(true);
    expect(w.baseCanFinish()).toBe(false);
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    expect(w.state.reviewedRevision).toBe(-1);
    expect(w.state.failures).toBe(0);
    expect(w.projection()).toMatchObject({ independentReview: { status: "skipped" }, requirementReview: [] });
    expect(w.nextAction()).toContain("check_requirements");
    expect(() => w.advance({ action: "understand", summary: "Ignore the missing evidence", requirements: ["Service works"] })).toThrow(/Keep/);

    w.observe({ id: "missing-evidence", name: "read_file", input: { path: "caller.ts" } }, { output: "raw caller source" });
    accept(w, { observationIds: ["missing-evidence"] });
    w.acceptFinalReport("Updated findings with the missing raw evidence");
    expect(w.canFinish()).toBe(true);
  });

  it("invalidates passing verification and acceptance after an actual write", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader"));
    w.observe({ id: "final-diff", name: "workspace_diff", input: {} }, { output: "complete diff" });
    accept(w); w.acceptFinalReport("Service and caller verified");
    w.applyEffect({ kind: "repository_write", changedFiles: ["caller.ts"] });
    expect(w.checksCurrent()).toBe(false);
    expect(w.canFinish()).toBe(false);
    expect(w.state.localCheck.status).toBe("pending");
    expect(w.state.broaderCheck.status).toBe("pending");
    expect(w.state.diffRevision).toBe(-1);
    expect(w.state.independentReview.status).toBe("skipped");
    expect(w.state.sequential?.steps[1]?.status).toBe("in_progress");
  });

  it("preserves real passing checks after a failed read while requiring renewed acceptance", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader"));
    w.observe({ id: "final-diff", name: "workspace_diff", input: {} }, { output: "complete diff" });
    accept(w); w.acceptFinalReport("Service and caller verified");
    const local = { ...w.state.localCheck }, broader = { ...w.state.broaderCheck };
    w.observe({ id: "broken-read", name: "read_file", input: { path: "caller.ts" } }, { output: "EACCES caller.ts", isError: true });
    expect(w.checksCurrent()).toBe(true);
    expect(w.state.localCheck).toEqual(local);
    expect(w.state.broaderCheck).toEqual(broader);
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    accept(w); w.acceptFinalReport("Service and caller verified using existing current receipts");
    expect(w.canFinish()).toBe(true);
  });

  it("preserves requirements and plan on recovery but invalidates architecture and all receipts", () => {
    const original = prepare(); finishStep(original, "service");
    const oldReceipt = receipt(original);
    const stored = WorkflowStateSchema.parse(JSON.parse(JSON.stringify(original.snapshot())));
    const resumed = new SequentialWorkflow("Original user wording", () => {}, stored, {}, "change");
    expect(resumed.state.requirements).toEqual(original.state.requirements);
    expect(resumed.state.sequential?.steps.map(step => step.status)).toEqual(["pending", "pending"]);
    expect(() => resumed.advance({ action: "start_step", stepId: "service" })).toThrow(/architecture/);
    expect(() => resumed.advance({ action: "architecture", summary: "old architecture", evidenceIds: ["recon"] })).toThrow(/fresh/);
    inspect(resumed, "fresh");
    resumed.advance({ action: "architecture", summary: "rechecked architecture", evidenceIds: ["fresh"] });
    resumed.advance({ action: "start_step", stepId: "service" });
    resumed.recordVerification(oldReceipt);
    expect(resumed.state.sequential?.steps[0]?.status).toBe("in_progress");
    resumed.recordVerification(receipt(resumed));
    expect(resumed.state.sequential?.steps[0]?.status).toBe("verified");
  });

  it("requires a reason to replace the plan and refuses receipts from the previous plan", () => {
    const w = prepare(); finishStep(w, "service");
    const oldReceipt = receipt(w);
    const plan = { action: "plan", steps: [{ id: "replacement", text: "Revised implementation", verification: [check("revised-check")] }], integration: [check("revised-integration")] };
    expect(() => w.advance(plan)).toThrow(/reason/);
    w.advance({ ...plan, reason: "Repository evidence requires a different approach" });
    w.advance({ action: "start_step", stepId: "replacement" });
    w.recordVerification(oldReceipt);
    expect(w.state.sequential?.steps[0]?.status).toBe("in_progress");
    expect(w.state.requirements).toEqual(["Service works", "Caller uses service"]);
    expect(() => w.advance({ action: "understand", summary: "Only service", requirements: ["Service works"] })).toThrow(/Keep/);
  });

  it("does not let optional/disabled profile integration or external changes satisfy completion", () => {
    const w = prepare(new SequentialWorkflow("Implement", () => {}, undefined, { broaderPolicy: "disabled" }, "change"));
    expect(w.state.broaderPolicy).toBe("required");
    finishStep(w, "service"); finishStep(w, "caller");
    w.recordVerification(receipt(w, "broader"));
    w.applyEffect({ kind: "repository_write", changedFiles: ["external.ts"] });
    expect(w.checksCurrent()).toBe(false);
    expect(w.state.sequential?.steps[1]?.status).toBe("in_progress");
  });
});
