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
  w.advance({ action: "plan", steps: [
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

describe("sequential implementation gates", () => {
  it("requires understanding, fresh exploration, architecture and a plan before writes", () => {
    const w = new SequentialWorkflow("Implement", () => {});
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toContain("workflow_preparation_required");
    expect(w.needsChange).toBe(true);
    inspect(w, "too-early");
    w.advance({ action: "understand", summary: "Implement service", requirements: ["Service works"] });
    expect(() => w.advance({ action: "architecture", summary: "architecture", evidenceIds: ["too-early"] })).toThrow(/fresh/);
    expect(() => w.advance({ action: "architecture", summary: "architecture", evidenceIds: ["invented"] })).toThrow(/fresh/);
    expect(() => w.advance({ action: "plan", steps: [{ id: "one", text: "one", verification: [check("test")] }], integration: [check("integration")] })).toThrow(/identify architecture/);
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

  it("requires integration followed by fresh diff and independent review", () => {
    const w = prepare();
    finishStep(w, "service"); finishStep(w, "caller");
    w.observe({ id: "early-diff", name: "git_diff", input: {} }, { output: "diff" });
    expect(w.state.diffRevision).toBe(-1);
    expect(w.checksCurrent()).toBe(false);
    w.recordVerification(receipt(w, "broader"));
    expect(w.checksCurrent()).toBe(true);
    w.acceptFinalReport("Done");
    expect(w.baseCanFinish()).toBe(false);
    w.observe({ id: "final-diff", name: "git_diff", input: {} }, { output: "complete diff" });
    w.acceptFinalReport("Service and caller verified");
    expect(w.baseCanFinish()).toBe(true);
    expect(w.canFinish()).toBe(false);
    w.recordIndependentReview(true, "Requirements and integration coverage verified");
    expect(w.canFinish()).toBe(true);
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
