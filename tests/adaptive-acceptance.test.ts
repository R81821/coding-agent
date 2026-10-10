import { describe, expect, it } from "vitest";
import { nowIso, WorkflowStateSchema, type VerificationRun } from "@harness/protocol";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";

function workflow(mode: "analysis" | "change" = "change") {
  return new LightweightWorkflow("Verify service behavior", () => {}, undefined, { broaderPolicy: "required" }, mode);
}
function verification(w: LightweightWorkflow, stage: "local" | "broader", fingerprint?: string): VerificationRun {
  return { id: "verify-" + stage, runId: "run", attempt: 0, stage, epoch: w.state.epoch, revision: w.state.revision,
    ...(fingerprint ? { codeFingerprint: fingerprint } : {}), passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(),
    results: [{ itemId: stage, command: "node --test tests/service.test.mjs", cwd: ".", exitCode: 0, passed: true, required: true, output: "Service regression passed", durationMs: 5, timedOut: false }] };
}
function source(w: LightweightWorkflow, id = "source") {
  w.observe({ id, name: "read_file", input: { path: "service.ts" } }, { output: "export const service = () => true;" });
}
function diff(w: LightweightWorkflow, id = "diff", fingerprint?: string) {
  w.observe({ id, name: "workspace_diff", input: {} }, { output: { changedFiles: ["service.ts"], diff: "+export const service = () => true;" } });
  if (fingerprint) w.bindObservationFingerprint(id, fingerprint);
}
function tests(w: LightweightWorkflow, fingerprint?: string) {
  w.recordVerification(verification(w, "local", fingerprint));
  w.recordVerification(verification(w, "broader", fingerprint));
}
function receipt(w: LightweightWorkflow, diffId = "diff") {
  return [{ requirementId: w.state.requirementIds[0]!, passed: true, summary: "The source and real test suites cover the service behavior", observationIds: ["source"], verificationIds: [w.state.localCheck.runId, w.state.broaderCheck.runId], diffObservationId: diffId }];
}
function ready() {
  const w = workflow();
  w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] });
  tests(w);
  source(w);
  diff(w);
  return w;
}
function readOnlyReceipt(w: LightweightWorkflow) {
  return [{ requirementId: w.state.requirementIds[0]!, passed: true, summary: "The current source establishes the reported behavior", observationIds: ["source"], verificationIds: [] as string[], diffObservationId: "" }];
}

describe("adaptive requirement acceptance", () => {
  it("clears prior read-only completion before the runtime parses an explicit acceptance request", () => {
    const w = workflow("analysis"); source(w);
    w.acceptFinalReport("An initial report supported by source.");
    expect(w.canFinish()).toBe(true);
    w.beginRequirementAcceptance();
    // A parser failure occurs outside acceptRequirements, so this marker must precede parsing.
    w.acceptFinalReport("A malformed explicit verdict must not fall back to the previous report.");
    expect(w.canFinish()).toBe(false);
    expect(w.state.explicitRequirementAcceptance).toBe(true);
    expect(w.state.requirementReceipts).toEqual([]);
  });

  it.each(["read_file", "probe"]) ("accepts explicit read-only %s evidence without requiring inaccessible write-mode tests or diff", tool => {
    const w = workflow("analysis");
    w.observe({ id: "source", name: tool, input: { path: "service.ts" } }, { output: "Observed service behavior" });
    const evidence = readOnlyReceipt(w);
    w.acceptRequirements(evidence);
    expect(w.canFinish()).toBe(false);
    w.acceptFinalReport("The source establishes the service behavior.");
    expect(w.canFinish()).toBe(true);
    expect(w.state.requirementReceipts).toEqual(evidence.map(({ passed: _passed, ...item }) => item));
    expect(w.state.explicitRequirementAcceptance).toBe(true);
    expect(() => WorkflowStateSchema.parse(w.snapshot())).not.toThrow();
  });

  it.each(["failed", "truncated", "stale-revision", "stale-epoch", "missing", "empty", "rejected"]) ("does not let a final report override %s explicit read-only acceptance", kind => {
    const w = workflow("analysis"); source(w);
    const evidence = readOnlyReceipt(w), observation = w.state.observations[0]!;
    if (kind === "failed") observation.failed = true;
    if (kind === "truncated") observation.complete = false;
    if (kind === "stale-revision") observation.revision--;
    if (kind === "stale-epoch") observation.epoch = "previous";
    if (kind === "missing") evidence[0]!.observationIds = ["invented"];
    if (kind === "empty") evidence[0]!.observationIds = [];
    if (kind === "rejected") evidence[0]!.passed = false;
    expect(() => w.acceptRequirements(evidence)).toThrow();
    // Even new valid evidence cannot turn a rejected explicit verdict into automatic acceptance.
    source(w, "new-source");
    w.acceptFinalReport("Everything is now understood.");
    expect(w.canFinish()).toBe(false);
    expect(w.state.requirementsRevision).toBe(-1);
    evidence[0] = { ...readOnlyReceipt(w)[0]!, observationIds: ["new-source"] };
    w.acceptRequirements(evidence);
    w.acceptFinalReport("The additional source resolves the issue.");
    expect(w.canFinish()).toBe(true);
  });

  it.each(["diff", "verification"]) ("authenticates optional %s evidence in a read-only acceptance", kind => {
    const w = workflow("analysis"); source(w);
    const evidence = readOnlyReceipt(w);
    if (kind === "diff") evidence[0]!.diffObservationId = "source";
    else evidence[0]!.verificationIds = ["claimed-test"];
    expect(() => w.acceptRequirements(evidence)).toThrow();
    w.acceptFinalReport("Do not hide an invalid optional reference.");
    expect(w.canFinish()).toBe(false);
  });

  it("allows genuine optional runtime test and diff references on a read-only task", () => {
    const w = workflow("analysis"); source(w); tests(w); diff(w);
    w.acceptRequirements(receipt(w));
    w.acceptFinalReport("The source and read-only observations support this conclusion.");
    expect(w.canFinish()).toBe(true);
  });

  it.each(["empty-tests", "missing-broader", "fake-test", "missing-diff"]) ("preserves strict change acceptance for %s", kind => {
    const w = ready(), evidence = receipt(w);
    if (kind === "empty-tests") evidence[0]!.verificationIds = [];
    if (kind === "missing-broader") evidence[0]!.verificationIds = [w.state.localCheck.runId];
    if (kind === "fake-test") evidence[0]!.verificationIds = ["claimed-test"];
    if (kind === "missing-diff") evidence[0]!.diffObservationId = "";
    expect(() => w.acceptRequirements(evidence)).toThrow();
    w.acceptFinalReport("A final report cannot forge runtime acceptance.");
    expect(w.canFinish()).toBe(false);
    expect(w.checksCurrent()).toBe(true);
  });

  it("reuses an earlier complete diff when runtime diff and tests have the same code fingerprint", () => {
    const w = workflow(); w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] });
    source(w); diff(w, "diff", "same-code"); tests(w, "same-code"); diff(w, "latest-diff", "same-code");
    expect(w.state.observations.find(item => item.id === w.state.localCheck.runId)?.codeFingerprint).toBe("same-code");
    w.acceptRequirements(receipt(w));
    w.acceptFinalReport("Runtime fingerprints prove the diff and tests cover the same code.");
    expect(w.canFinish()).toBe(true);
  });

  it.each(["missing-diff-fingerprint", "missing-test-fingerprint", "different-fingerprint"]) ("rejects an early diff with %s", kind => {
    const w = workflow(); w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] }); source(w);
    diff(w, "diff", kind === "missing-diff-fingerprint" ? undefined : "diff-code");
    tests(w, kind === "missing-test-fingerprint" ? undefined : "test-code");
    expect(() => w.acceptRequirements(receipt(w))).toThrow(/after its passing test suites|different runtime workspace fingerprints/);
    expect(w.canFinish()).toBe(false);
  });

  it("rejects different fingerprints even when the diff is newer than its tests", () => {
    const w = workflow(); w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] }); source(w);
    tests(w, "tested-code"); diff(w, "diff", "other-code");
    expect(() => w.acceptRequirements(receipt(w))).toThrow(/different runtime workspace fingerprints/);
  });

  it("cannot reuse an older diff if the latest complete runtime diff has different content", () => {
    const w = workflow(); w.applyEffect({ kind: "repository_write", changedFiles: ["service.ts"] }); source(w);
    diff(w, "diff", "tested-code"); tests(w, "tested-code"); diff(w, "latest-diff", "other-code");
    expect(() => w.acceptRequirements(receipt(w))).toThrow(/latest complete/);
  });

  it.each(["read_file", "search_text", "apply_patch", "patch"]) ("preserves real passed suites after a confirmed non-mutating %s failure", tool => {
    const w = ready(); w.acceptRequirements(receipt(w)); w.acceptFinalReport("Previously accepted.");
    const before = w.snapshot();
    if (["patch", "apply_patch"].includes(tool)) w.applyEffect({ kind: "read", changedFiles: [] });
    w.observe({ id: "failed-request", name: tool, input: { path: "service.ts" } }, { isError: true, output: ["patch", "apply_patch"].includes(tool) ? { applied: false, phase: "validation", diagnostic: { kind: "format" }, error: "Invalid patch header" } : "ENOENT: requested path is absent" });
    expect(w.state.localCheck).toEqual(before.localCheck);
    expect(w.state.broaderCheck).toEqual(before.broaderCheck);
    expect(w.state.failures).toBe(before.failures + 1);
    expect(w.state.lastFailure).toContain(tool);
    expect(w.state.requirementsRevision).toBe(-1);
    expect(w.canFinish()).toBe(false);
    w.acceptRequirements(receipt(w)); w.acceptFinalReport("The malformed request did not alter the verified source.");
    expect(w.canFinish()).toBe(true);
  });

  it.each(["unknown", "repository_write", "apply-failure", "test-failure"]) ("still invalidates checks after %s", kind => {
    const w = ready();
    if (kind === "test-failure") w.recordVerification({ ...verification(w, "local"), passed: false, outcome: "failed", results: [{ ...verification(w, "local").results[0]!, passed: false, exitCode: 1, output: "Assertion failed" }] });
    else {
      w.applyEffect({ kind: kind === "unknown" ? "unknown" : kind === "repository_write" ? "repository_write" : "read", changedFiles: kind === "repository_write" ? ["service.ts"] : [] });
      w.observe({ id: "failed-request", name: "apply_patch", input: {} }, { isError: true, output: { applied: false, phase: kind === "apply-failure" ? "apply" : "validation", diagnostic: { kind: "format" } } });
    }
    expect(w.checksCurrent()).toBe(false);
    expect(() => w.acceptRequirements(receipt(w))).toThrow(/test suites/);
  });

  it("keeps an unknown workspace effect sticky across ordinary reads", () => {
    const w = ready(); w.applyEffect({ kind: "unknown", changedFiles: [] });
    w.applyEffect({ kind: "read", changedFiles: [] }); source(w, "after-unknown");
    expect(w.state.effect).toBe("unknown");
    expect(w.checksCurrent()).toBe(false);
  });

  it("does not bind code fingerprints to non-diff, failed, truncated or stale observations", () => {
    const w = workflow("analysis"); source(w);
    w.bindObservationFingerprint("source", "code");
    for (const kind of ["failed", "truncated", "stale"]) {
      w.observe({ id: kind, name: "workspace_diff", input: {} }, { output: "diff", ...(kind === "failed" ? { isError: true } : {}), ...(kind === "truncated" ? { truncated: true } : {}) });
      if (kind === "stale") w.state.observations.at(-1)!.revision--;
      w.bindObservationFingerprint(kind, "code");
    }
    expect(w.state.observations.every(item => !item.codeFingerprint)).toBe(true);
  });
});
