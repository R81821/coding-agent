import { describe, expect, it } from "vitest";
import { summarizeVerificationReuse, type VerificationCacheDecision } from "../packages/core/src/verification-reuse.js";
import type { VerificationRun } from "@harness/protocol";

const taskRunId = "task-run";
const command = "node --test test/a.test.mjs";
const base = (sequence: number, runId = taskRunId) => ({ id: `event-${runId}-${sequence}`, runId, sequence });
const decision = (sequence: number, value: Partial<VerificationCacheDecision> = {}, runId = taskRunId) => ({
  ...base(sequence, runId), type: "verification_cache_decision" as const,
  verificationRunId: `verify-${sequence}`, itemId: "a", command, cwd: ".", cached: false,
  source: "executed" as const, force: false, reason: "no_saved_receipt", ...value,
});
const finish = (sequence: number, value: Partial<VerificationRun> = {}, runId = taskRunId) => ({
  ...base(sequence, runId), type: "verification_finished" as const,
  verification: {
    id: `verify-${sequence}`, runId, attempt: 0, stage: "local" as const, passed: true, outcome: "passed" as const,
    results: [{ itemId: "a", command, cwd: ".", passed: true, required: true, exitCode: 0, output: "passed", durationMs: 10, timedOut: false }],
    startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:00:01.000Z", ...value,
  },
});
const failed = (itemId = "a") => ({ itemId, command, cwd: ".", passed: false, required: true, exitCode: 1, output: "assertion failed", durationMs: 10, timedOut: false });

describe("durable verification reuse measurements", () => {
  it("counts explicit saved receipt decisions and separates forced execution and other reuse sources", () => {
    const summary = summarizeVerificationReuse([
      decision(1),
      decision(2, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "previous-verification", dependencyComplete: true }),
      decision(3, { force: true, reason: "forced" }),
      decision(4, { source: "checkpoint", reason: "checkpoint" }),
      decision(5, { source: "same_suite", reason: "same_suite" }),
      finish(6),
    ]);
    expect(summary).toMatchObject({
      measuredItems: 5, cacheHits: 1, cacheMisses: 2, forcedItems: 1, checkpointReuses: 1, sameSuiteReuses: 1,
      cacheHitRate: 1 / 3, reusedFromRunIds: ["previous-verification"], runsWithCacheHits: 1,
      runsWithFailureAfterReuse: 0, failureAfterReuse: false,
    });
    expect(summary.items[1]).toMatchObject({ cached: true, source: "saved_run", reusedFromRunId: "previous-verification", failureAfterReuse: false });
  });

  it("reports absent measurements as unknown without inferring misses from legacy receipts", () => {
    const event = finish(1);
    event.verification.results[0] = { ...event.verification.results[0]!, reusedFromRunId: "legacy-pass" } as typeof event.verification.results[number];
    expect(summarizeVerificationReuse([event])).toMatchObject({ measuredItems: 0, cacheHits: 0, cacheMisses: 0, cacheHitRate: null, failureAfterReuse: null, items: [] });
  });

  it("replays unordered persisted events and deduplicates an event seen in two pages", () => {
    const hit = decision(2, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "earlier-run" });
    const failure = finish(3, { passed: false, outcome: "failed", results: [failed()] });
    const events = [failure, hit, decision(1), hit];
    const summary = summarizeVerificationReuse(JSON.parse(JSON.stringify(events)) as typeof events);
    expect(summary).toMatchObject({ measuredItems: 2, cacheHits: 1, cacheMisses: 1, runsWithFailureAfterReuse: 1, failureAfterReuse: true });
    expect(summary.items.find(item => item.cached)).toMatchObject({ failureAfterReuse: true, sameItemFailureAfterReuse: true });
  });

  it("records a later different-suite failure as correlation without claiming the cached item failed", () => {
    const summary = summarizeVerificationReuse([
      decision(1, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-a" }),
      finish(2, { passed: false, outcome: "failed", results: [failed("integration")] }),
    ]);
    expect(summary.failureAfterReuse).toBe(true);
    expect(summary.items[0]).toMatchObject({ failureAfterReuse: true, sameItemFailureAfterReuse: false });
  });

  it("counts a planned-evidence downgrade as a verification failure even when the command passed", () => {
    const summary = summarizeVerificationReuse([
      decision(1, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-a" }),
      finish(2, { passed: false, outcome: "failed", skipReason: "Planned verification evidence is missing: node --test test/b.test.mjs" }),
    ]);
    expect(summary).toMatchObject({ failureAfterReuse: true, runsWithFailureAfterReuse: 1 });
    expect(summary.items[0]?.sameItemFailureAfterReuse).toBe(false);
  });

  it("does not mix tasks or turn failures before a cache hit and skipped pauses into later failures", () => {
    const summary = summarizeVerificationReuse([
      finish(1, { passed: false, outcome: "failed", results: [failed()] }),
      decision(2, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-a" }),
      finish(3, { passed: false, outcome: "skipped", skipReason: "Verification paused between suites; resume the saved unfinished items.", results: [failed()] }),
      finish(4, { passed: false, outcome: "failed", results: [failed()] }, "another-task"),
    ], taskRunId);
    expect(summary).toMatchObject({ failureAfterReuse: false, runsWithFailureAfterReuse: 0 });
    expect(summary.items).toHaveLength(1);
  });

  it("keeps cancellation distinct from failed assertions and still records timeouts as failures", () => {
    const hit = decision(1, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-a" });
    const cancelled = finish(2, {
      passed: false, outcome: "failed", skipReason: "verification_runtime_error: Run cancelled",
      results: [{ ...failed(), exitCode: null, output: "verification_runtime_error: Run cancelled", timedOut: false }],
    });
    const summary = summarizeVerificationReuse([hit, cancelled]);
    expect(summary).toMatchObject({ failureAfterReuse: false, abortedAfterReuse: true, runsWithFailureAfterReuse: 0 });
    expect(summarizeVerificationReuse([hit, finish(3, { passed: false, outcome: "failed", results: [{ ...failed(), exitCode: null, output: "The operation was aborted due to timeout", timedOut: true }] })])).toMatchObject({ failureAfterReuse: true, abortedAfterReuse: false });
  });

  it("reports each task separately and only saved-run hits contribute to the failure-after-reuse metric", () => {
    const summary = summarizeVerificationReuse([
      decision(1, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-a" }),
      decision(1, { source: "checkpoint", reason: "checkpoint" }, "other-task"),
      finish(2, { passed: false, outcome: "failed", results: [failed()] }, "other-task"),
      decision(3, { cached: true, source: "saved_run", reason: "saved_receipt", reusedFromRunId: "saved-b" }, "third-task"),
      finish(4, { passed: false, outcome: "failed", results: [failed()] }, "third-task"),
    ]);
    expect(summary).toMatchObject({ runsWithCacheHits: 2, runsWithFailureAfterReuse: 1, reusedFromRunIds: ["saved-a", "saved-b"] });
    expect(summary.items.find(item => item.runId === "other-task")?.failureAfterReuse).toBe(false);
  });
});
