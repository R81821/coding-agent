import { describe, expect, it } from "vitest";
import { CodingWorkflow } from "../packages/core/src/coding-workflow.js";
import { WorkflowStateSchema, type VerificationRun } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";

const writeTool = { ...workflowReadTool, contract: { ...workflowReadTool.contract, name: "apply_patch", risk: "write" as const, idempotent: false } };
const read = (flow: CodingWorkflow, id: string, tool = "read_file") => flow.observe({ id, name: tool, input: { path: "src/value.ts", query: "boundary" } }, { output: "observed source and boundaries" });
function flow(policy: ConstructorParameters<typeof CodingWorkflow>[3] = {}) {
  const value = new CodingWorkflow("fix the boundary", () => {}, undefined, policy);
  value.update({ action: "understand", intent: "change", requirements: ["preserve compatibility"] });
  read(value, "before");
  value.update({ action: "plan", context: "boundary missing", cause: "missing boundary", evidenceIds: ["before"], steps: ["small fix"] });
  value.starting({ id: "patch", name: "apply_patch", input: { patch: "--- a/src/auth.ts\n+++ b/src/auth.ts\n-old\n+new" } }, writeTool);
  return value;
}
function check(value: CodingWorkflow, stage: "local" | "broader", outcome: "passed" | "failed" | "skipped" = "passed") {
  const run: VerificationRun = { id: "verify-" + stage, runId: "test", stage, outcome, epoch: value.state.epoch, revision: value.state.revision, attempt: 0, passed: outcome === "passed", skipReason: outcome === "skipped" ? "optional and not configured" : "", results: [{ itemId: "target", command: "fixture", cwd: ".", exitCode: outcome === "passed" ? 0 : 1, passed: outcome === "passed", required: true, output: outcome === "failed" ? "FAILED boundary" : "passed", durationMs: 1, timedOut: false }], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  if (outcome === "skipped") run.results = [];
  value.recordVerification(run); return run;
}
function verified(value: CodingWorkflow) {
  check(value, "local"); check(value, "broader");
  value.observe({ id: "diff", name: "git_diff", input: {} }, { output: "complete diff" });
}
const receipt = () => ({ requirementId: "req-1", summary: "behavior tested", observationIds: ["diff"], verificationIds: ["verify-local"], diffObservationId: "diff" });
function diagnose(value: CodingWorkflow, extra: Record<string, unknown> = {}) {
  value.update({ action: "diagnose", context: "new boundary evidence", steps: ["adjust boundary"], cause: "revised boundary " + value.state.failures, evidenceIds: [value.state.activeFailureId], ...extra });
}

describe("workflow audit hardening", () => {
  it("permits early reads without displaying understanding as completed", () => {
    const value = new CodingWorkflow("inspect", () => {}); read(value, "early");
    expect(value.state.phase).toBe("task_understanding"); expect(value.state.activity).toContain("read_file");
  });
  it("rejects old diagnosis evidence but accepts this failure's runtime record", () => {
    const value = flow(); value.fail("FAILED boundary", "test");
    expect(() => diagnose(value, { evidenceIds: ["before"] })).toThrow("this failure's evidence");
    diagnose(value); expect(value.state.diagnosisRequired).toBe(false);
    read(value, "after-diagnosis"); expect(value.state.phase).toBe("update_hypothesis");
  });
  it("enforces new repository checks for a recurring failure without resetting on changed cause", () => {
    const value = flow(); value.fail("FAILED boundary", "test"); diagnose(value);
    value.fail("FAILED boundary", "test"); expect(value.failureLevel).toBe(2);
    expect(() => diagnose(value)).toThrow("fresh successful repository");
    read(value, "new-read"); diagnose(value, { evidenceIds: [value.state.activeFailureId, "new-read"] });
    expect(value.failureLevel).toBe(2);
  });
  it("enforces expanded search, alternatives and observed experiments at level three", () => {
    const value = flow(); value.fail("FAILED boundary", "test"); value.fail("FAILED boundary", "test"); value.fail("FAILED boundary", "test");
    read(value, "reread");
    expect(() => diagnose(value, { evidenceIds: [value.state.activeFailureId, "reread"] })).toThrow("distinct alternatives");
    read(value, "expanded", "search_text");
    const extra = { evidenceIds: [value.state.activeFailureId, "expanded"], alternatives: ["wrong caller", "wrong condition"], experiment: { question: "Which layer handles null?", expectedResults: ["caller rejects", "callee rejects"], observationIds: ["before"] } };
    expect(() => diagnose(value, extra)).toThrow("observed experiment results");
    extra.experiment.observationIds = ["expanded"]; diagnose(value, extra);
    expect(value.state.hypotheses.at(-1)?.experiment?.observationIds).toEqual(["expanded"]);
  });
  it("uses separate chains for new faults and closes a chain only on matching successful checks", () => {
    const value = flow(); check(value, "local", "failed"); diagnose(value);
    check(value, "local", "failed"); expect(value.failureLevel).toBe(2);
    value.fail("ENOENT other.ts", "tool:read_file:other.ts"); expect(value.failureLevel).toBe(1);
    const previous = value.state.failureChains.find(item => item.source === "verification:local:target")!;
    expect(previous.status).toBe("open"); check(value, "local"); expect(previous.status).toBe("resolved");
    check(value, "local", "failed"); expect(value.failureLevel).toBe(1); expect(value.state.failures).toBe(4);
  });
  it("distinguishes optional skipped broader checks from required missing checks", () => {
    const optional = flow(); check(optional, "local"); check(optional, "broader", "skipped");
    expect(optional.checksCurrent()).toBe(true); expect(optional.state.broaderRevision).toBe(-1); expect(optional.state.broaderCheck.status).toBe("skipped");
    const required = flow({ broaderPolicy: "required" }); check(required, "local"); check(required, "broader", "skipped"); expect(required.checksCurrent()).toBe(false);
  });
  it("rejects fabricated, failed and outdated evidence references", () => {
    const value = flow(); verified(value);
    expect(() => value.update({ action: "requirements", passed: true, evidence: [{ ...receipt(), verificationIds: ["invented"] }] })).toThrow("verification reference");
    expect(() => value.update({ action: "requirements", passed: true, evidence: [{ ...receipt(), observationIds: ["before"] }] })).toThrow("current epoch and revision");
    expect(() => value.update({ action: "requirements", passed: true, evidence: [{ ...receipt(), requirementId: "other" }] })).toThrow("requirementId");
    value.update({ action: "requirements", passed: true, evidence: [receipt()] });
    expect(() => value.update({ action: "review", passed: true, summary: "fine", evidenceIds: ["before"] })).toThrow("current epoch and revision");
  });
  it("cannot use a later truncated diff to inherit a previous complete diff gate", () => {
    const value = flow(); verified(value);
    value.observe({ id: "partial", name: "git_diff", input: {} }, { output: "partial", truncated: true });
    expect(value.state.diffRevision).toBe(-1);
    expect(() => value.update({ action: "requirements", passed: true, evidence: [receipt()] })).toThrow("complete git_diff");
  });
  it("preserves old evidence on migration but invalidates analysis stamps and epoch", () => {
    const original = new CodingWorkflow("explain", () => {}); original.update({ action: "understand", intent: "analysis", requirements: ["explain"] }); read(original, "analysis-read"); check(original, "local"); check(original, "broader");
    const saved = JSON.parse(JSON.stringify(original.snapshot())); delete saved.schemaVersion; delete saved.localCheck; delete saved.broaderCheck;
    const restored = new CodingWorkflow("explain", () => {}, WorkflowStateSchema.parse(saved));
    expect(restored.state.epoch).not.toBe(original.state.epoch); expect(restored.state.observations[0]?.id).toBe("analysis-read");
    expect(restored.state.localCheck.status).toBe("pending"); expect(restored.state.localRevision).toBe(-1); expect(restored.checksCurrent()).toBe(false);
    expect(() => restored.recordVerification({ ...check(original, "local"), epoch: original.state.epoch })).toThrow("Stale verification");
  });
  it("flags sensitive rename-only patches and unidentified patch scopes for review", () => {
    const value = new CodingWorkflow("rename", () => {}, undefined, { reviewPolicy: "risk_based" });
    value.starting({ id: "rename", name: "apply_patch", input: { patch: "diff --git a/src/auth.ts b/src/login.ts\nsimilarity index 100%\nrename from src/auth.ts\nrename to src/login.ts\n" } }, writeTool);
    expect(value.state.changedFiles).toEqual(expect.arrayContaining(["src/auth.ts", "src/login.ts"]));
    expect(value.state.riskFlags).toContain("sensitive_path");
    const unknown = new CodingWorkflow("patch", () => {}, undefined, { reviewPolicy: "risk_based" });
    unknown.starting({ id: "patch", name: "apply_patch", input: { patch: "unrecognized metadata" } }, writeTool);
    expect(unknown.requiresIndependentReview).toBe(true);
  });
  it("requires runtime-owned independent review on risky changes when enabled", () => {
    const value = flow({ reviewPolicy: "risk_based" }); verified(value);
    value.update({ action: "requirements", passed: true, evidence: [receipt()] });
    value.update({ action: "review", passed: true, summary: "fine", evidenceIds: ["diff"], independentReview: { status: "passed" } });
    expect(value.baseCanFinish()).toBe(true); expect(value.canFinish()).toBe(false);
    value.recordIndependentReview(true, "independent evidence reviewed"); expect(value.canFinish()).toBe(true);
    value.starting({ id: "patch2", name: "apply_patch", input: { patch: "+++ b/src/auth.ts\n-old\n+new" } }, writeTool);
    expect(value.state.independentReview.status).toBe("pending"); expect(value.canFinish()).toBe(false);
  });
});