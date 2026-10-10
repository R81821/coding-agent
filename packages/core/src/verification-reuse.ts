import type { VerificationRun } from "@harness/protocol";

export interface VerificationCacheDecision {
  verificationRunId: string;
  itemId: string;
  command: string;
  cwd: string;
  /** A hit denotes a saved verification run, not checkpoint recovery or suite deduplication. */
  cached: boolean;
  source: "saved_run" | "checkpoint" | "same_suite" | "executed" | "unavailable";
  force: boolean;
  reason: string;
  reusedFromRunId?: string;
  dependencyComplete?: boolean;
}

type EventHeader = { id?: string; runId: string; sequence: number; type: string };
type DecisionEvent = EventHeader & VerificationCacheDecision;
type FinishedEvent = EventHeader & { verification: VerificationRun };

export interface VerificationReuseItem extends VerificationCacheDecision {
  runId: string;
  sequence: number;
  failureAfterReuse: boolean;
  sameItemFailureAfterReuse: boolean;
  abortedAfterReuse: boolean;
}

export interface VerificationReuseSummary {
  measuredItems: number;
  cacheHits: number;
  cacheMisses: number;
  forcedItems: number;
  checkpointReuses: number;
  sameSuiteReuses: number;
  cacheHitRate: number | null;
  unforcedCacheHitRate: number | null;
  reusedFromRunIds: string[];
  runsWithCacheHits: number;
  runsWithFailureAfterReuse: number;
  /** Unknown means no saved-run reuse was observed, not evidence that reuse is safe. */
  failureAfterReuse: boolean | null;
  abortedAfterReuse: boolean | null;
  items: VerificationReuseItem[];
}

/** Only a synthetic cancellation receipt is an abort; timeouts and command failures stay failures. */
function isCancellation(verification: VerificationRun): boolean {
  const cancellation = /^(?:verification_runtime_error:\s*)?(?:run cancel(?:led|ed)|(?:this |the )?operation was aborted\.?|AbortError(?::.*)?)$/i;
  const failed = verification.results.filter(result => !result.passed);
  return failed.length > 0 && failed.every(result => result.exitCode === null && !result.timedOut && cancellation.test(result.output.trim()));
}

/**
 * Replay durable events without changing verification decisions. Old receipts alone cannot prove
 * whether a cache lookup happened, so only explicit item decisions contribute to hit/miss counts.
 * Later failures are correlation within the same task run; they do not establish cache causality.
 */
export function summarizeVerificationReuse(events: readonly EventHeader[], runId?: string): VerificationReuseSummary {
  const seen = new Set<string>();
  const ordered = events.filter(event => {
    if (runId !== undefined && event.runId !== runId) return false;
    const identity = `${event.runId}:${event.id ?? `${event.type}:${event.sequence}`}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).toSorted((a, b) => a.sequence - b.sequence);
  const finished = ordered.filter(event => event.type === "verification_finished") as FinishedEvent[];
  const decisions = ordered.filter(event => event.type === "verification_cache_decision") as DecisionEvent[];
  const failures = finished.filter(event => !event.verification.passed && event.verification.outcome !== "skipped" && !isCancellation(event.verification));
  const aborts = finished.filter(event => !event.verification.passed && event.verification.outcome !== "skipped" && isCancellation(event.verification));
  const items: VerificationReuseItem[] = decisions.map(event => {
    const cached = event.cached && event.source === "saved_run";
    const laterFailures = cached ? failures.filter(failure => failure.runId === event.runId && failure.sequence > event.sequence) : [];
    return {
      verificationRunId: event.verificationRunId,
      itemId: event.itemId,
      command: event.command,
      cwd: event.cwd,
      cached,
      source: event.source,
      force: event.force,
      reason: event.reason,
      ...(event.reusedFromRunId !== undefined ? { reusedFromRunId: event.reusedFromRunId } : {}),
      ...(event.dependencyComplete !== undefined ? { dependencyComplete: event.dependencyComplete } : {}),
      runId: event.runId,
      sequence: event.sequence,
      failureAfterReuse: laterFailures.length > 0,
      sameItemFailureAfterReuse: laterFailures.some(failure => failure.verification.results.some(result => result.itemId === event.itemId && !result.passed)),
      abortedAfterReuse: cached && aborts.some(abort => abort.runId === event.runId && abort.sequence > event.sequence),
    };
  });
  const cacheItems = items.filter(item => item.source === "saved_run" || item.source === "executed" || item.source === "unavailable");
  const hits = cacheItems.filter(item => item.cached);
  const unforced = cacheItems.filter(item => !item.force);
  return {
    measuredItems: items.length,
    cacheHits: hits.length,
    cacheMisses: cacheItems.length - hits.length,
    forcedItems: items.filter(item => item.force).length,
    checkpointReuses: items.filter(item => item.source === "checkpoint").length,
    sameSuiteReuses: items.filter(item => item.source === "same_suite").length,
    cacheHitRate: cacheItems.length > 0 ? hits.length / cacheItems.length : null,
    unforcedCacheHitRate: unforced.length > 0 ? unforced.filter(item => item.cached).length / unforced.length : null,
    reusedFromRunIds: [...new Set(hits.flatMap(item => item.reusedFromRunId ? [item.reusedFromRunId] : []))].sort(),
    runsWithCacheHits: new Set(hits.map(item => item.runId)).size,
    runsWithFailureAfterReuse: new Set(hits.filter(item => item.failureAfterReuse).map(item => item.runId)).size,
    failureAfterReuse: hits.length > 0 ? hits.some(item => item.failureAfterReuse) : null,
    abortedAfterReuse: hits.length > 0 ? hits.some(item => item.abortedAfterReuse) : null,
    items,
  };
}
