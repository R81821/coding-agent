import { describe, expect, it } from "vitest";
import { behaviorCases, prepareBehaviorReview, summarizeBehaviorReview, type BehaviorSample, type BehaviorReview } from "../packages/evals/src/behavior.js";

// Synthetic data verifies the evaluator, never constitutes a model-quality result.
function fixture(): BehaviorSample[] {
  return behaviorCases.flatMap(item => [0, 1, 2].flatMap(repetition => (["baseline", "optimized"] as const).map(arm => ({
    caseId: item.id, repetition, arm, runId: `${item.id}-${repetition}-${arm}`, answer: `${arm} answer`, requestSettingsHash: "a".repeat(64), inputFixtureHash: "b".repeat(64),
    elapsedMs: 100, toolCalls: 1, inputTokens: 1000, outputTokens: 100, estimatedUsd: .01, completed: true,
  }))));
}
function review(pairs: ReturnType<typeof prepareBehaviorReview>["pairs"]): BehaviorReview[] {
  return pairs.map(pair => ({ id: pair.id, reviewer: "human-fixture", reviewerKind: "human", preference: "b", scoreA: 3, scoreB: 4,
    factualErrorsA: 0, factualErrorsB: 0, irrelevantTestsA: 0, irrelevantTestsB: 0, forcedGraphA: false, forcedGraphB: false,
    fabricatedClaimsA: false, fabricatedClaimsB: false, safetyRegression: false }));
}
describe("paired behavior evaluation evidence", () => {
  it("requires all 30 cases and three real identified runs in each arm", () => {
    expect(behaviorCases).toHaveLength(30);
    expect(() => prepareBehaviorReview([])).toThrow(/Missing/);
    const samples = fixture(); samples[0]!.inputFixtureHash = "different";
    expect(() => prepareBehaviorReview(samples)).toThrow(/Incomparable/);
    samples[0]!.inputFixtureHash = samples[1]!.inputFixtureHash; samples[0]!.runId = samples[1]!.runId;
    expect(() => prepareBehaviorReview(samples)).toThrow(/duplicated/);
  });
  it("blinds the arm and holds release for model-only, incomplete or unsafe reviews", () => {
    const samples = fixture(), prepared = prepareBehaviorReview(samples, 3, () => 0);
    expect(prepared.pairs).toHaveLength(90); expect(prepared.pairs[0]).not.toHaveProperty("arm");
    const reviews = review(prepared.pairs);
    expect(() => summarizeBehaviorReview(samples, prepared.key, [])).toThrow(/human/);
    expect(() => summarizeBehaviorReview(samples, prepared.key, reviews.map(item => ({ ...item, reviewerKind: "model" })))).toThrow(/human/);
    const result = summarizeBehaviorReview(samples, prepared.key, reviews);
    expect(result).toMatchObject({ decision: "eligible_for_release_review", questions: 30, pairedRuns: 90 });
    expect(result.byCase).toHaveLength(30);
    reviews[0]!.irrelevantTestsB = 1; reviews[1]!.safetyRegression = true;
    expect(summarizeBehaviorReview(samples, prepared.key, reviews)).toMatchObject({ decision: "hold", blockers: expect.arrayContaining(["irrelevant_consultation_work", "safety_or_fabrication"]) });
  });
});
