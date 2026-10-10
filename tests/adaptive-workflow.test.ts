import { describe, expect, it, vi } from "vitest";
import { nowIso, type VerificationRun, type WorkflowState } from "@harness/protocol";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const suite = (file: string) => ({ command: `node --test tests/${file}.test.mjs`, cwd: ".", timeoutMs: 1000 });
const step = (id: string, dependsOn?: string[]) => ({ id, text: `Implement ${id}`, verification: [suite(id)], ...(dependsOn ? { dependsOn } : {}) });
function setup(taskMode: "auto" | "analysis" | "change" = "change") {
  const publish = vi.fn();
  const workflow = new SequentialWorkflow("Implement service and caller", publish, undefined, {}, taskMode);
  workflow.observe({ id: "source", name: "read_file", input: { path: "service.ts" } }, { output: "export function service() { return 1; }" });
  publish.mockClear();
  return { workflow, publish };
}
function configure(workflow: SequentialWorkflow, steps = [step("service"), step("caller")], extra: Record<string, unknown> = {}) {
  workflow.advance({ action: "configure", summary: "Implement service and caller", requirements: ["Service works", "Caller stays compatible"],
    architecture: "service.ts implements the service; caller.ts composes it", evidenceIds: ["source"], steps,
    integration: [suite("integration")], ...extra });
}
function receipt(workflow: SequentialWorkflow, stage: "local" | "broader" = "local"): VerificationRun {
  return { id: `verify-${stage}-${Math.random()}`, runId: "run", attempt: 0, stage, epoch: workflow.state.epoch, revision: workflow.state.revision,
    passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(),
    results: workflow.plannedChecks().filter(check => check.stage === stage).map(check => ({ itemId: check.id, command: check.command, cwd: check.cwd,
      exitCode: 0, passed: true, required: true, output: "Test suite passed", durationMs: 1, timedOut: false })),
  };
}
function verifiedPlan() {
  const fixture = setup();
  configure(fixture.workflow, [step("service"), step("caller", ["service"]), step("docs")]);
  fixture.workflow.advance({ action: "start_step", stepId: "service" });
  fixture.workflow.recordVerification(receipt(fixture.workflow));
  fixture.workflow.advance({ action: "start_step", stepId: "caller" });
  fixture.workflow.advance({ action: "start_step", stepId: "docs" });
  fixture.workflow.recordVerification(receipt(fixture.workflow));
  expect(fixture.workflow.state.sequential?.steps.every(item => item.status === "verified")).toBe(true);
  fixture.publish.mockClear();
  return fixture;
}
type ActionProjection = { availableSteps: string[]; completionBlockers: string[]; suggestedActions: { action: string; reason: string; stepId?: string }[] };
const projection = (workflow: SequentialWorkflow) => workflow.projection() as unknown as ActionProjection;

describe("adaptive workflow configuration and planning", () => {
  it.each([
    { name: "inline test suite", extra: { steps: [{ ...step("service"), verification: [{ ...suite("service"), command: "node -e 'process.exit(0)'" }] }] } },
    { name: "unknown dependency", extra: { steps: [step("service", ["missing"])] } },
    { name: "dependency cycle", extra: { steps: [step("service", ["caller"]), step("caller", ["service"])] } },
    { name: "unknown startStepId", extra: { startStepId: "missing" } },
    { name: "blocked startStepId", extra: { steps: [step("service"), step("caller", ["service"])], startStepId: "caller" } },
  ])("validates configure atomically for $name", ({ extra }) => {
    const { workflow, publish } = setup();
    const before = workflow.snapshot();
    expect(() => configure(workflow, undefined, extra)).toThrow();
    expect(workflow.state).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("configures requirements, architecture, plan and an optional first step in one action", () => {
    const { workflow, publish } = setup();
    configure(workflow, undefined, { startStepId: "caller" });
    expect(workflow.state.requirements).toEqual(["Service works", "Caller stays compatible"]);
    expect(workflow.state.sequential).toMatchObject({ mode: "adaptive", activeStepId: "caller", architectureEpoch: workflow.state.epoch });
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["pending", "in_progress"]);
    expect(workflow.state.todos?.find(item => item.id === "caller")).toMatchObject({ stepId: "caller", status: "in_progress" });
    expect(publish).toHaveBeenCalled();
    expect(workflow.canFinish()).toBe(false);
  });

  it("defaults new plans to adaptive but resumes checkpoints without a mode as ordered", () => {
    const { workflow } = setup();
    workflow.advance({ action: "understand", summary: "Implement service", requirements: ["Service works"] });
    workflow.advance({ action: "architecture", summary: "service.ts contains the service", evidenceIds: ["source"] });
    workflow.advance({ action: "plan", steps: [step("service"), step("caller")], integration: [suite("integration")] });
    expect(workflow.state.sequential?.mode).toBe("adaptive");
    const stored = JSON.parse(JSON.stringify(workflow.snapshot())) as WorkflowState;
    delete (stored.sequential as unknown as Record<string, unknown>).mode;
    const recovered = new SequentialWorkflow("Original user wording", () => {}, stored, {}, "change");
    expect(recovered.state.sequential?.mode).toBe("ordered");
  });

  it("lets independent steps switch before grouped local verification", () => {
    const { workflow } = setup();
    configure(workflow);
    workflow.advance({ action: "start_step", stepId: "caller" });
    workflow.advance({ action: "start_step", stepId: "service" });
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["in_progress", "in_progress"]);
    expect(workflow.plannedChecks().filter(item => item.stage === "local").map(item => item.command).sort()).toEqual([suite("service").command, suite("caller").command].sort());
    workflow.recordVerification(receipt(workflow));
    expect(workflow.state.sequential?.steps.map(item => item.status)).toEqual(["verified", "verified"]);
    expect(workflow.state.todos?.map(item => item.status)).toEqual(["completed", "completed"]);
    expect(workflow.canFinish()).toBe(false);
  });

  it("requires real passing dependency verification rather than a verified status alone", () => {
    const { workflow } = setup();
    configure(workflow, [step("service"), step("caller", ["service"])]);
    expect(() => workflow.advance({ action: "start_step", stepId: "caller" })).toThrow();
    // Simulate corrupt or model-authored progress without any runtime receipt.
    workflow.state.sequential!.steps[0]!.status = "verified";
    expect(() => workflow.advance({ action: "start_step", stepId: "caller" })).toThrow();
    workflow.state.sequential!.steps[0]!.status = "pending";
    workflow.advance({ action: "start_step", stepId: "service" });
    workflow.recordVerification(receipt(workflow));
    expect(projection(workflow).availableSteps).toContain("caller");
    expect(() => workflow.advance({ action: "start_step", stepId: "caller" })).not.toThrow();
  });

  it("updates text and order while retaining stable test identities and real passing checks", () => {
    const { workflow } = verifiedPlan();
    const before = workflow.snapshot().sequential!.steps;
    const old = new Map(before.map(item => [item.id, item]));
    const receiptIds = new Map(workflow.plannedChecks().map(item => [item.command, item.id]));
    workflow.advance({ action: "update_plan", reason: "Describe the completed implementation more clearly and group documentation first", steps: [
      { ...step("docs"), text: "Document the tested service contract" },
      { ...step("service"), text: "Implement the verified service" },
    ] });
    expect(workflow.state.sequential?.steps.map(item => item.id)).toEqual(["docs", "service", "caller"]);
    for (const item of workflow.state.sequential!.steps) {
      expect(item.verificationKey).toBeTruthy();
      expect(item.verificationKey).toBe(old.get(item.id)?.verificationKey);
      expect(item.check).toEqual(old.get(item.id)?.check);
      expect(item.status).toBe("verified");
    }
    expect(workflow.state.sequential?.steps.find(item => item.id === "caller")?.dependsOn).toEqual(["service"]);
    for (const item of workflow.plannedChecks()) expect(item.id).toBe(receiptIds.get(item.command));
    expect(workflow.state.todos?.find(item => item.id === "docs")?.text).toBe("Document the tested service contract");
  });

  it("preserves omitted dependencies on same-ID upserts", () => {
    const { workflow } = verifiedPlan();
    const caller = workflow.snapshot().sequential!.steps.find(item => item.id === "caller")!;
    workflow.advance({ action: "update_plan", reason: "Clarify caller responsibility", steps: [{ ...step("caller"), text: "Keep the caller compatible" }] });
    const updated = workflow.state.sequential!.steps.find(item => item.id === "caller")!;
    expect(updated.dependsOn).toEqual(["service"]);
    expect(updated.verificationKey).toBe(caller.verificationKey);
    expect(updated.check).toEqual(caller.check);
    expect(updated.status).toBe("verified");
  });

  it("resets a changed test suite and its dependency successors while preserving independent verified work", () => {
    const { workflow } = verifiedPlan();
    const old = new Map(workflow.snapshot().sequential!.steps.map(item => [item.id, item]));
    workflow.advance({ action: "update_plan", reason: "Cover the service boundary regression in a persisted test file", steps: [
      { ...step("service"), verification: [suite("service-boundary")] },
    ] });
    const steps = new Map(workflow.state.sequential!.steps.map(item => [item.id, item]));
    expect(steps.get("service")?.status).toBe("pending");
    expect(steps.get("caller")?.status).toBe("pending");
    expect(steps.get("service")?.check.status).toBe("pending");
    expect(steps.get("caller")?.check.status).toBe("pending");
    expect(steps.get("service")?.verificationKey).not.toBe(old.get("service")?.verificationKey);
    expect(steps.get("docs")?.status).toBe("verified");
    expect(steps.get("docs")?.check).toEqual(old.get("docs")?.check);
    expect(steps.get("docs")?.verificationKey).toBe(old.get("docs")?.verificationKey);
    expect(workflow.canFinish()).toBe(false);
  });

  it("rejects dangling dependencies atomically and allows removing an entire dependency branch", () => {
    const { workflow, publish } = verifiedPlan();
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "update_plan", reason: "Remove service", removeStepIds: ["service"] })).toThrow();
    expect(workflow.state).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
    workflow.advance({ action: "update_plan", reason: "Drop the service branch from this implementation plan", removeStepIds: ["service", "caller"] });
    expect(workflow.state.sequential?.steps.map(item => item.id)).toEqual(["docs"]);
    expect(workflow.state.todos?.map(item => item.id)).toEqual(["docs"]);
  });

  it("reports available actions, dependencies and completion evidence without fabricating completion", () => {
    const { workflow } = setup();
    const unplanned = projection(workflow);
    expect(unplanned.availableSteps).toEqual([]);
    expect(unplanned.completionBlockers.length).toBeGreaterThan(0);
    expect(unplanned.suggestedActions.some(item => ["understand", "configure"].includes(item.action))).toBe(true);
    workflow.acceptFinalReport("Everything is complete without an implementation plan");
    expect(workflow.canFinish()).toBe(false);
    configure(workflow, [step("service"), step("caller", ["service"]), step("docs")]);
    const planned = projection(workflow);
    expect(planned.availableSteps).toEqual(["service", "docs"]);
    expect(planned.suggestedActions.some(item => item.action === "start_step" && item.stepId === "service" && item.reason.length > 0)).toBe(true);
    expect(planned.completionBlockers.length).toBeGreaterThan(0);
    workflow.acceptFinalReport("Everything is complete without test receipts");
    expect(workflow.canFinish()).toBe(false);
    workflow.advance({ action: "start_step", stepId: "service" });
    workflow.recordVerification(receipt(workflow));
    const checked = projection(workflow);
    expect(checked.availableSteps).not.toContain("service");
    expect(checked.availableSteps).toContain("caller");
    expect(checked.completionBlockers.length).toBeGreaterThan(0);
    workflow.acceptFinalReport("Everything is complete");
    expect(workflow.canFinish()).toBe(false);
  });
});

describe("analysis intent in adaptive workflow understanding", () => {
  it("allows correcting an auto-mode intent before any plan or repository write", () => {
    const { workflow } = setup("auto");
    workflow.advance({ action: "understand", summary: "Initial interpretation", requirements: ["Explain the source"] });
    expect(workflow.state.intent).toBe("change");
    workflow.advance({ action: "understand", intent: "analysis", summary: "The request only requires explaining source", requirements: ["Explain the source"] });
    expect(workflow.state.intent).toBe("analysis");
    expect(workflow.needsChange).toBe(false);
  });
  it("allows auto mode to classify a read-only task as analysis without requiring implementation tests", () => {
    const { workflow } = setup("auto");
    workflow.advance({ action: "understand", intent: "analysis", summary: "Explain service behavior", requirements: ["Explain the service behavior using source evidence"] });
    expect(workflow.state.intent).toBe("analysis");
    expect(workflow.needsChange).toBe(false);
    expect(workflow.state.sequential?.steps).toEqual([]);
  });

  it.each(["analysis", "change"] as const)("does not downgrade an explicitly selected %s mode", mode => {
    const { workflow, publish } = setup(mode);
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "understand", intent: "analysis", summary: "Read only", requirements: ["Explain source"] })).toThrow();
    expect(workflow.state).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["write", "plan"] as const)("does not downgrade auto mode after an actual %s", reason => {
    const { workflow, publish } = setup("auto");
    if (reason === "write") workflow.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] });
    else configure(workflow);
    publish.mockClear();
    const before = workflow.snapshot();
    expect(() => workflow.advance({ action: "understand", intent: "analysis", summary: "Ignore implementation", requirements: ["Explain source"] })).toThrow();
    expect(workflow.state).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });
});
