import { expect, it } from "vitest";
import { reviewChanges } from "../packages/core/src/independent-review.js";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelRequest, Usage } from "@harness/protocol";
const model = descriptor({ providerId: "fake", modelId: "review", displayName: "Review" });
async function review(result: unknown) {
  const requests: ModelRequest[] = [], usage: Usage[] = [];
  const provider: ModelProvider = { id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; }, async *stream(request) { requests.push(request); yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3, estimatedUsd: 0, costKnown: false } }; yield { type: "text_delta", delta: JSON.stringify(result) }; } };
  const workflow = new LightweightWorkflow("Fix timeout\nPreserve cancellation", () => {}, undefined, {}, "change");
  const output = await reviewChanges({ provider, model, runId: "review", state: workflow.snapshot(), diff: "fixture diff", observations: [], verificationRuns: [], signal: new AbortController().signal, remainingUsd: 1, onUsage: value => usage.push(value) });
  return { output, requests, usage };
}
it.each([
  { passed: true, summary: "all good" },
  { passed: true, summary: "one only", requirements: [{ id: "req-1", passed: true, evidence: "test A" }] },
  { passed: true, summary: "duplicate", requirements: [{ id: "req-1", passed: true, evidence: "test A" }, { id: "req-1", passed: true, evidence: "test A" }] },
  { passed: true, summary: "failure", requirements: [{ id: "req-1", passed: true, evidence: "test A" }, { id: "req-2", passed: false, evidence: "cancellation untested" }] },
])("rejects incomplete per-requirement review: $summary", async result => { expect((await review(result)).output.passed).toBe(false); });
it("accepts all requirement verdicts and classifies review usage", async () => {
  const result = await review({ passed: true, summary: "covered", requirements: [{ id: "req-1", passed: true, evidence: "timeout test" }, { id: "req-2", passed: true, evidence: "cancellation test" }] });
  expect(result.output.passed).toBe(true);
  expect(result.requests[0]).toMatchObject({ purpose: "review", tools: [], store: false });
  expect(result.usage[0]).toMatchObject({ purpose: "review", costKnown: false });
});
it("retains requirements beyond the twentieth line and 3000 characters", () => {
  const objective = Array.from({ length: 25 }, (_, i) => String(i) + "x".repeat(3100)).join("\n");
  const workflow = new LightweightWorkflow(objective, () => {});
  expect(workflow.state.requirements).toHaveLength(25);
  expect(workflow.state.requirements.at(-1)).toHaveLength(3102);
});
