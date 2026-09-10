import { describe, expect, it } from "vitest";
import { CodingWorkflow, compactObservation } from "../packages/core/src/coding-workflow.js";
import { workflowReadTool } from "./workflow-fixture.js";
import type { ToolDefinition } from "@harness/tools";
import { WorkflowStateSchema } from "@harness/protocol";

const patch: ToolDefinition = { ...workflowReadTool, contract: { ...workflowReadTool.contract, name: "apply_patch", risk: "write", idempotent: false } };
const call = { id: "patch-1", name: "apply_patch", input: { patch: "+++ b/src/value.ts\n-old\n+new" } };
function planned() {
  const flow = new CodingWorkflow("Fix value", () => {});
  flow.update({ action: "understand", intent: "change", requirements: ["Correct value"] });
  flow.observe({ id: "read-1", name: "read_file", input: { path: "src/value.ts" } }, { output: "old" });
  flow.update({ action: "plan", context: "value is old", steps: ["replace old value"], cause: "outdated value", evidenceIds: ["read-1"] });
  return flow;
}
function verified(flow: CodingWorkflow) {
  for (const stage of ["local", "broader"] as const) flow.recordVerification({ id: "verify-" + stage, runId: "fixture", stage, epoch: flow.state.epoch, revision: flow.state.revision, attempt: 0, passed: true, results: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  flow.observe({ id: "diff", name: "git_diff", input: {} }, { output: "-old +new" });
  flow.update({ action: "requirements", passed: true, evidence: [{ requirementId: "req-1", summary: "value test passed", observationIds: ["diff"], verificationIds: ["verify-local"], diffObservationId: "diff" }] });
  flow.update({ action: "review", passed: true, evidenceIds: ["diff"], summary: "Minimal diff; compatibility and edge cases checked" });
}
describe("coding workflow gates", () => {
  it("reports action-specific missing fields without blaming recorded understanding", async () => {
    const flow = planned();
    const result = await flow.tool().execute({ action: "plan", context: "new context", steps: ["small fix"] }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ code: "workflow_input_invalid", action: "plan", missingFields: ["cause", "evidenceIds"], recoverable: true });
    expect(JSON.stringify(result.output)).not.toContain("Record understanding first");
    expect(flow.state.hypotheses).toHaveLength(1);
  });
  it("accepts the original failed tool call as diagnosis evidence", () => {
    const flow = planned();
    flow.observe({ id: "failed-patch", name: "apply_patch", input: call.input }, { isError: true, output: "Patch validation failed" });
    flow.update({ action: "diagnose", context: "patch hunk is stale", steps: ["reread the changed hunk"], cause: "stale patch context", evidenceIds: ["failed-patch"] });
    expect(flow.state.diagnosisRequired).toBe(false);
  });
  it("returns usable current evidence IDs when rejecting stale evidence", async () => {
    const flow = planned();
    flow.observe({ id: "failed-patch", name: "apply_patch", input: call.input }, { isError: true, output: "Patch validation failed" });
    const result = await flow.tool().execute({ action: "diagnose", context: "patch mismatch", steps: ["fix hunk"], cause: "stale hunk", evidenceIds: ["read-1"] }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ availableEvidenceIds: expect.arrayContaining(["failed-patch", flow.state.activeFailureId]) });
    expect((result.output as { availableEvidenceIds: string[] }).availableEvidenceIds).not.toContain("read-1");
    expect(flow.state.diagnosisRequired).toBe(true);
  });
  it("registers missing verification on the request without creating a failure or rewriting the plan", () => {
    const flow = planned(); const hypothesis = flow.snapshot().hypotheses;
    expect(() => flow.update({ action: "request_verification" })).toThrow("verification");
    flow.update({ action: "request_verification", verification: [{ stage: "local", command: "node --check value.js" }] });
    expect(flow.state.verification).toMatchObject([{ command: "node --check value.js", cwd: "." }]);
    expect(flow.state.hypotheses).toEqual(hypothesis);
    expect(flow.state.failures).toBe(0);
    expect(flow.canFinish()).toBe(false);
  });
  it("still rejects malformed input and model-authored verification results", async () => {
    const flow = planned();
    const badType = await flow.tool().execute({ action: "request_verification", verification: "node test.js" }, {} as never);
    expect(badType).toMatchObject({ isError: true, output: { code: "workflow_input_invalid" } });
    const forged = await flow.tool().execute({ action: "request_verification", passed: true }, {} as never);
    expect(forged).toMatchObject({ isError: true, output: { code: "workflow_gate_rejected", error: "Only runtime can report verification results." } });
    expect(flow.state.verification).toEqual([]);
    expect(flow.canFinish()).toBe(false);
  });
  it("keeps script source out of failure-chain identity and distinguishes different scripts", () => {
    const flow = planned();
    const script = 'print("' + "private-probe-".repeat(3000) + '")';
    flow.observe({ id: "python-1", name: "terminal", input: { command: "python -", stdin: script } }, { isError: true, output: "SyntaxError" });
    flow.observe({ id: "python-2", name: "terminal", input: { command: "python -", stdin: "other script" } }, { isError: true, output: "SyntaxError" });
    expect(flow.state.failureChains).toHaveLength(2);
    expect(flow.state.failureChains.every(chain => chain.source.length < 300)).toBe(true);
  });
  it("blocks editing before understanding, reconnaissance and an evidence-backed hypothesis", () => {
    const flow = new CodingWorkflow("fix", () => {});
    expect(flow.before(call, patch)).toContain("understand");
    flow.update({ action: "understand", intent: "change", requirements: ["fix value"] });
    expect(flow.before(call, patch)).toContain("plan");
    expect(() => flow.update({ action: "plan", context: "x", steps: ["x"], cause: "x", evidenceIds: ["invented"] })).toThrow("actual observed");
    expect(planned().before(call, patch)).toBeUndefined();
  });
  it("cannot mark completion with model claims or a truncated diff", () => {
    const flow = planned(); flow.starting(call, patch);
    expect(() => flow.update({ action: "review", passed: true, summary: "done" })).toThrow("runtime verification");
    verified(flow);
    flow.observe({ id: "diff", name: "git_diff", input: {} }, { output: "partial", truncated: true });
    expect(() => flow.update({ action: "requirements", passed: true, evidence: [{ requirementId: "req-1", summary: "done", observationIds: ["diff"], verificationIds: ["verify-local"], diffObservationId: "diff" }] })).toThrow("complete git_diff");
    expect(flow.canFinish()).toBe(false);
  });
  it("invalidates every successful gate on the next possible mutation", () => {
    const flow = planned(); flow.starting(call, patch); verified(flow);
    expect(flow.canFinish()).toBe(true);
    flow.starting({ ...call, id: "patch-2" }, patch);
    expect(flow.canFinish()).toBe(false);
    expect(flow.state).toMatchObject({ revision: 2, localRevision: -1, broaderRevision: -1, diffRevision: -1, requirementsRevision: -1, reviewedRevision: -1, changedFiles: ["src/value.ts"] });
  });
  it("requires a revised hypothesis after failure and escalates strategy", () => {
    const flow = planned(); flow.fail("test failed");
    expect(flow.before(call, patch)).toContain("diagnose");
    expect(() => flow.update({ action: "diagnose", context: "same", steps: ["same"], cause: "outdated value", evidenceIds: ["read-1"] })).toThrow("Revise");
    flow.update({ action: "diagnose", context: "boundary found", steps: ["fix boundary"], cause: "null boundary not handled", evidenceIds: [flow.state.activeFailureId] });
    expect(flow.before(call, patch)).toBeUndefined();
    flow.fail("test failed"); expect(flow.failureLevel).toBe(2);
    flow.fail("test failed"); expect(flow.strategy()).toContain("替代假设");
  });
  it("requirement and review failures return to diagnosis without erasing acceptance criteria", () => {
    const flow = planned(); flow.starting(call, patch); verified(flow);
    flow.update({ action: "requirements", passed: false, summary: "edge case remains" });
    expect(flow.state.phase).toBe("diagnose"); expect(flow.canFinish()).toBe(false);
    expect(() => flow.update({ action: "understand", intent: "analysis", requirements: ["easier"] })).toThrow("already recorded");
  });
  it("persists working memory but invalidates verification when recovering", () => {
    const flow = planned(); flow.starting(call, patch); verified(flow);
    const recovered = new CodingWorkflow("fix", () => {}, WorkflowStateSchema.parse(JSON.parse(JSON.stringify(flow.snapshot()))));
    expect(recovered.state.requirements).toEqual(flow.state.requirements);
    expect(recovered.state.hypotheses).toEqual(flow.state.hypotheses);
    expect(recovered.canFinish()).toBe(false);
  });
  it("bounds working observations and retains failure details from long logs", () => {
    const flow = planned();
    for (let i=0; i<50; i++) flow.observe({ id: String(i), name: "read_file", input: {} }, { output: "x".repeat(30000) });
    expect(flow.state.observations).toHaveLength(32);
    expect(flow.state.observations.every(o => o.summary.length <= 1200)).toBe(true);
    const summary = compactObservation("first\n" + "noise\n".repeat(5000) + "FAILED target: expected 1 actual 2\n" + "noise\n".repeat(5000) + "last", 2000);
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary).toContain("FAILED target"); expect(summary).toContain("first"); expect(summary).toContain("last");
  });
});