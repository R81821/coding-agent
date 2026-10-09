import { expect, it } from "vitest";
import { prepareReviewRequest, reviewChanges } from "../packages/core/src/independent-review.js";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { descriptor, ProviderOutputTruncatedError, type ModelProvider } from "@harness/providers";
import type { ModelRequest, Usage } from "@harness/protocol";
import type { RequestTiming } from "../packages/core/src/model-request.js";
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
  expect(result.requests[0]!.maxOutputTokens).toBe(8192);
  expect(result.usage[0]).toMatchObject({ purpose: "review", costKnown: false });
});
it("preserves rejected requirement findings so the main agent can repair the evidence", async () => {
  const requirements = [{ id: "req-1", passed: true, evidence: "timeout test" }, { id: "req-2", passed: false, evidence: "Missing raw cancellation source" }];
  const result = await review({ passed: true, summary: "missing evidence", requirements });
  expect(result.output.passed).toBe(false);
  expect(result.output.requirements).toEqual(requirements);
});

it("clips review allowance without dropping evidence, and uses full-request estimates", () => {
  const workflow = new LightweightWorkflow("检查取消行为", () => {}, undefined, {}, "change");
  const smallModel = descriptor({ providerId: "fake", modelId: "small", displayName: "Small", maxContextTokens: 5000 });
  const diff = "完整证据".repeat(40);
  const prepared = prepareReviewRequest({ model: smallModel, runId: "review", state: workflow.snapshot(), diff, observations: ["untrusted evidence"], verificationRuns: [], maxOutputTokens: 16_384, configuredMaxOutputTokens: 8192 });
  expect(prepared.maxOutputTokens).toBeGreaterThan(0);
  expect(prepared.maxOutputTokens).toBeLessThan(8192);
  expect(prepared.maxOutputTokens + prepared.estimatedInputTokens).toBeLessThan(5000);
  expect(JSON.stringify(prepared.request.messages)).toContain(diff);
  expect(JSON.stringify(prepared.request.messages)).toContain("检查取消行为");
  expect(prepared.request).not.toHaveProperty("compactionMode");
  expect(() => prepareReviewRequest({ model: smallModel, runId: "review", state: workflow.snapshot(), diff: diff.repeat(100), observations: [], verificationRuns: [] })).toThrow("context_budget_exceeded");
});

it("preserves reasoning usage and request diagnostics when the reviewer is truncated", async () => {
  const usage: Usage[] = [], timings: RequestTiming[] = [], requests: ModelRequest[] = [];
  const workflow = new LightweightWorkflow("Fix timeout", () => {}, undefined, {}, "change");
  const provider: ModelProvider = {
    id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(request);
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 8192, reasoningTokens: 8192, estimatedUsd: .03 } };
      throw new ProviderOutputTruncatedError("max_output_tokens");
    },
  };
  await expect(reviewChanges({ provider, model, runId: "review", state: workflow.snapshot(), diff: "full diff", observations: [], verificationRuns: [], signal: new AbortController().signal, remainingUsd: 1, maxOutputTokens: 8192, configuredMaxOutputTokens: 16_384, attempt: 1, onUsage: value => usage.push(value), onModelRequestFinished: value => timings.push(value) })).rejects.toBeInstanceOf(ProviderOutputTruncatedError);
  expect(requests).toHaveLength(1);
  expect(usage).toEqual([{ purpose: "review", inputTokens: 50, outputTokens: 8192, reasoningTokens: 8192, estimatedUsd: .03 }]);
  expect(timings[0]).toMatchObject({ purpose: "review", succeeded: false, maxOutputTokens: 8192, configuredMaxOutputTokens: 16_384, attempt: 1, errorCode: "provider_output_truncated" });
});

it("reserves unknown provider usage, and refuses requests that exceed remaining fees", async () => {
  const usage: Usage[] = [], requests: ModelRequest[] = [];
  const workflow = new LightweightWorkflow("Fix timeout", () => {}, undefined, {}, "change");
  const provider: ModelProvider = {
    id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return .05; },
    async *stream(request) { requests.push(request); throw new ProviderOutputTruncatedError("max_output_tokens"); },
  };
  const input = { provider, model, runId: "review", state: workflow.snapshot(), diff: "full diff", observations: [], verificationRuns: [], signal: new AbortController().signal, remainingUsd: 1, onUsage: (value: Usage) => usage.push(value) };
  await expect(reviewChanges(input)).rejects.toBeInstanceOf(ProviderOutputTruncatedError);
  expect(usage).toEqual([{ purpose: "review", inputTokens: 0, outputTokens: 0, estimatedUsd: .05, costKnown: false }]);
  await expect(reviewChanges({ ...input, remainingUsd: .04 })).rejects.toThrow("费用预算不足");
  expect(requests).toHaveLength(1);
  expect(usage).toHaveLength(1);
});

it("does not retry malformed JSON, disallowed tools, or length violations", async () => {
  const workflow = new LightweightWorkflow("Fix timeout", () => {}, undefined, {}, "change");
  for (const event of [{ type: "text_delta" as const, delta: "invalid JSON" }, { type: "tool_call" as const, toolCall: { id: "forbidden", name: "read_file", input: { path: "file" } } }, { type: "text_delta" as const, delta: "x".repeat(16_001) }]) {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = { id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; }, async *stream(request) { requests.push(request); yield event; } };
    await expect(reviewChanges({ provider, model, runId: "review", state: workflow.snapshot(), diff: "full diff", observations: [], verificationRuns: [], signal: new AbortController().signal, remainingUsd: 1, onUsage: () => {} })).rejects.toBeDefined();
    expect(requests).toHaveLength(1);
  }
});
it("retains requirements beyond the twentieth line and 3000 characters", () => {
  const objective = Array.from({ length: 25 }, (_, i) => String(i) + "x".repeat(3100)).join("\n");
  const workflow = new LightweightWorkflow(objective, () => {});
  expect(workflow.state.requirements).toHaveLength(25);
  expect(workflow.state.requirements.at(-1)).toHaveLength(3102);
});
