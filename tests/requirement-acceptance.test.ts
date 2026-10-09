import { describe, expect, it } from "vitest";
import { nowIso, type VerificationRun } from "@harness/protocol";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { requirementAcceptanceTool, todoTool } from "../packages/core/src/runtime-tools.js";

const context = { runId: "run", workspacePath: ".", grants: [], signal: new AbortController().signal };
function verification(w: LightweightWorkflow, stage: "local" | "broader"): VerificationRun {
  return { id: "verify-" + stage, runId: "run", attempt: 0, stage, epoch: w.state.epoch, revision: w.state.revision, passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(), results: [{ itemId: stage, command: "pnpm test -- tests/service.test.ts", cwd: ".", exitCode: 0, passed: true, required: true, output: "2 tests passed", durationMs: 5, timedOut: false }] };
}
function ready() {
  const w = new LightweightWorkflow("Fix service\nPreserve caller compatibility", () => {}, undefined, { broaderPolicy: "required", reviewPolicy: "risk_based" }, "change");
  w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts", "service.test.ts"] });
  w.recordVerification(verification(w, "local"));
  w.recordVerification(verification(w, "broader"));
  w.observe({ id: "source", name: "read_file", input: { path: "service.ts" } }, { output: "actual current service code" });
  w.observe({ id: "diff", name: "workspace_diff", input: {} }, { output: "complete diff includes implementation and tests" });
  return w;
}
function evidence(w: LightweightWorkflow) {
  return w.state.requirementIds.map(requirementId => ({ requirementId, passed: true, summary: "Service test file covers the changed behavior and caller regression", observationIds: ["source"], verificationIds: [w.state.localCheck.runId, w.state.broaderCheck.runId], diffObservationId: "diff" }));
}

describe("test-backed runtime requirement acceptance", () => {
  it("requires structured test evidence before a final report can complete a change", async () => {
    const w = ready();
    await todoTool(w).execute({ items: [{ id: "all", text: "Everything done", status: "completed" }] }, context);
    w.acceptFinalReport("All done, verified and reviewed");
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    const result = await requirementAcceptanceTool(w).execute({ evidence: evidence(w) }, context);
    expect(result).toMatchObject({ output: { accepted: true } });
    expect(w.state.requirementsRevision).toBe(w.state.revision);
    expect(w.state.reviewedRevision).toBe(-1);
    expect(w.canFinish()).toBe(false);
    w.acceptFinalReport("Service and caller test suites passed; requirements have current code and diff evidence");
    expect(w.canFinish()).toBe(true);
    expect(w.state.independentReview).toMatchObject({ status: "skipped", runId: "", revision: w.state.revision, epoch: w.state.epoch });
    expect(w.state.independentReview.reason).toContain("实际测试");
    expect(w.state.requirementReceipts.every(item => !item.summary.includes("Pending independent"))).toBe(true);
  });

  it.each(["missing", "duplicate", "invented", "rejected"])("rejects %s requirement verdicts without erasing passing suites", async kind => {
    const w = ready(), receipts = evidence(w), before = w.snapshot();
    if (kind === "missing") receipts.pop();
    if (kind === "duplicate") receipts[1]!.requirementId = receipts[0]!.requirementId;
    if (kind === "invented") receipts[1]!.requirementId = "made-up";
    if (kind === "rejected") receipts[1]!.passed = false;
    const result = await requirementAcceptanceTool(w).execute({ evidence: receipts }, context);
    expect(result).toMatchObject({ isError: true, output: { code: "requirement_gate_rejected", requirementIds: w.state.requirementIds } });
    expect(w.state.localCheck).toEqual(before.localCheck);
    expect(w.state.broaderCheck).toEqual(before.broaderCheck);
    expect(w.state.requirementsRevision).toBe(-1);
    expect(w.canFinish()).toBe(false);
  });

  it.each(["failed", "truncated", "old-revision", "old-epoch", "invented"])("rejects %s observation evidence", async kind => {
    const w = ready(), source = w.state.observations.find(item => item.id === "source")!;
    if (kind === "failed") source.failed = true;
    if (kind === "truncated") source.complete = false;
    if (kind === "old-revision") source.revision--;
    if (kind === "old-epoch") source.epoch = "other-epoch";
    const receipts = evidence(w);
    if (kind === "invented") receipts[0]!.observationIds = ["made-up"];
    expect(await requirementAcceptanceTool(w).execute({ evidence: receipts }, context)).toMatchObject({ isError: true, output: { code: "requirement_gate_rejected" } });
    expect(w.canFinish()).toBe(false);
  });

  it.each(["empty-run", "manual-stamp", "missing-local", "missing-integration", "invented"])("rejects %s verification receipts", async kind => {
    const w = ready(), receipts = evidence(w);
    if (kind === "empty-run") w.recordVerification({ ...verification(w, "local"), results: [] });
    if (kind === "manual-stamp") w.state.localCheck.runId = "manually-claimed";
    if (kind === "missing-local") receipts[0]!.verificationIds = [w.state.broaderCheck.runId];
    if (kind === "missing-integration") receipts[0]!.verificationIds = [w.state.localCheck.runId];
    if (kind === "invented") receipts[0]!.verificationIds = ["invented"];
    if (kind === "empty-run" || kind === "manual-stamp") for (const item of receipts) item.verificationIds = [w.state.localCheck.runId, w.state.broaderCheck.runId];
    expect(await requirementAcceptanceTool(w).execute({ evidence: receipts }, context)).toMatchObject({ isError: true });
    expect(w.canFinish()).toBe(false);
  });

  it("requires a complete current diff and forbids using source reads as a diff", async () => {
    const w = ready(), receipts = evidence(w);
    receipts[0]!.diffObservationId = "source";
    expect(await requirementAcceptanceTool(w).execute({ evidence: receipts }, context)).toMatchObject({ isError: true });
    w.observe({ id: "partial-diff", name: "workspace_diff", input: {} }, { output: "partial diff", truncated: true });
    expect(await requirementAcceptanceTool(w).execute({ evidence: evidence(w) }, context)).toMatchObject({ isError: true });
    expect(w.canFinish()).toBe(false);
  });

  it("requires the latest complete diff even when an older diff has the same revision", () => {
    const w = ready(), receipts = evidence(w);
    w.observe({ id: "latest-diff", name: "workspace_diff", input: {} }, { output: "fresh complete diff after suites" });
    expect(() => w.acceptRequirements(receipts)).toThrow(/latest complete/);
    w.acceptRequirements(receipts.map(item => ({ ...item, diffObservationId: "latest-diff" })));
    w.acceptFinalReport("Current diff and suites accepted");
    expect(w.canFinish()).toBe(true);
  });

  it("requires a new diff after the most recent successful verification", () => {
    const w = ready(), receipts = evidence(w);
    w.recordVerification({ ...verification(w, "broader"), id: "verify-broader-later" });
    for (const item of receipts) item.verificationIds = [w.state.localCheck.runId, w.state.broaderCheck.runId];
    expect(() => w.acceptRequirements(receipts)).toThrow(/after its passing test suites/);
    w.observe({ id: "fresh-diff", name: "workspace_diff", input: {} }, { output: "complete diff after rerun" });
    w.acceptRequirements(receipts.map(item => ({ ...item, diffObservationId: "fresh-diff" })));
    w.acceptFinalReport("Retested and refreshed diff");
    expect(w.canFinish()).toBe(true);
  });

  it("clears completed acceptance when a new suite run changes its current verification receipt", () => {
    const w = ready();
    w.acceptRequirements(evidence(w)); w.acceptFinalReport("Done");
    expect(w.canFinish()).toBe(true);
    w.recordVerification({ ...verification(w, "local"), id: "latest-local" });
    w.acceptFinalReport("Cannot reuse receipt references from before the new test run");
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    expect(w.state.reviewedRevision).toBe(-1);
  });

  it("restores real current test receipts while requiring fresh acceptance after continuation", () => {
    const previous = ready(); previous.acceptRequirements(evidence(previous)); previous.acceptFinalReport("Old completed report");
    const snapshot = previous.snapshot();
    // The engine reuses checkpoints only after its workspace fingerprint check succeeds.
    const continued = new LightweightWorkflow("continued task", () => {}, snapshot, { broaderPolicy: "required" }, "change");
    Object.assign(continued.state, structuredClone(snapshot));
    continued.restoreVerificationRuns([verification(previous, "local"), verification(previous, "broader")]);
    expect(continued.checksCurrent()).toBe(true);
    expect(continued.state.requirementsRevision).toBe(-1);
    expect(continued.state.reviewedRevision).toBe(-1);
    continued.acceptFinalReport("Cannot inherit old acceptance");
    expect(continued.canFinish()).toBe(false);
    continued.acceptRequirements(evidence(continued)); continued.acceptFinalReport("New acceptance uses the real unchanged-workspace suites");
    expect(continued.canFinish()).toBe(true);
    expect(continued.state.independentReview.status).toBe("skipped");
  });

  it.each(["absent", "empty", "old-revision", "old-epoch"])("requires suites to rerun when restored receipts are %s", kind => {
    const previous = ready(), snapshot = previous.snapshot();
    const continued = new LightweightWorkflow("continued task", () => {}, snapshot, { broaderPolicy: "required" }, "change");
    Object.assign(continued.state, structuredClone(snapshot));
    const runs = [verification(previous, "local"), verification(previous, "broader")];
    if (kind === "absent") runs.length = 0;
    if (kind === "empty") runs[0]!.results = [];
    if (kind === "old-revision") runs[0]!.revision = snapshot.revision - 1;
    if (kind === "old-epoch") runs[0]!.epoch = "other-epoch";
    continued.restoreVerificationRuns(runs);
    expect(continued.checksCurrent()).toBe(false);
    expect(continued.state.localCheck.status).toBe("pending");
    expect(continued.state.localCheck.reason).toContain("重新运行套件");
    expect(() => continued.acceptRequirements(evidence(continued))).toThrow(/test suites/);
  });

  it.each(["mutation", "failure", "unknown-effect", "recovery"])("invalidates acceptance and real test registration after %s", async kind => {
    let w = ready();
    w.acceptRequirements(evidence(w)); w.acceptFinalReport("Done");
    expect(w.canFinish()).toBe(true);
    const receipts = evidence(w);
    if (kind === "mutation") w.applyEffect({ kind: "repository_write", changedFiles: ["caller.ts"] });
    if (kind === "failure") w.observe({ id: "failed-read", name: "read_file", input: {} }, { output: "EACCES", isError: true });
    if (kind === "unknown-effect") w.applyEffect({ kind: "unknown", changedFiles: [] });
    if (kind === "recovery") w = new LightweightWorkflow("same request", () => {}, w.snapshot(), { broaderPolicy: "required" }, "change");
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    expect(w.state.reviewedRevision).toBe(-1);
    expect(w.state.independentReview.status).toBe("skipped");
    expect(await requirementAcceptanceTool(w).execute({ evidence: receipts }, context)).toMatchObject({ isError: true });
  });

  it("keeps a pure analysis report read-only without implementation test requirements", () => {
    const w = new LightweightWorkflow("Explain service", () => {}, undefined, {}, "analysis");
    w.observe({ id: "source", name: "read_file", input: {} }, { output: "actual service code" });
    w.acceptFinalReport("Explanation supported by source");
    expect(w.canFinish()).toBe(true);
    expect(w.requiresIndependentReview).toBe(false);
    expect(w.state.independentReview.status).toBe("skipped");
  });
});
