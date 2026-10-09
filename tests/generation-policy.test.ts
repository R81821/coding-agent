import { describe, expect, it } from "vitest";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
import { runWithPiAgent } from "@harness/core";
import type { RequestTiming } from "../packages/core/src/model-request.js";
import { initialReviewOutputTokens, nextReviewOutputTokens, resolveMainOutputTokens, resolveRequestOutputTokens, resolveReviewOutputLimit } from "../packages/core/src/generation-policy.js";

describe("generation allowances", () => {
  it("keeps legacy main defaults and independent automatic review headroom", () => {
    expect(resolveMainOutputTokens()).toBe(393_216);
    expect(resolveReviewOutputLimit()).toBe(32_768);
    expect(resolveMainOutputTokens({ maxOutputTokens: 4000, reviewMaxOutputTokens: 10_000 })).toBe(4000);
    expect(resolveReviewOutputLimit({ maxOutputTokens: 4000, reviewMaxOutputTokens: 10_000 })).toBe(10_000);
    expect(initialReviewOutputTokens(4)).toBe(8192);
    expect(initialReviewOutputTokens(30)).toBe(12_000);
    expect(initialReviewOutputTokens(100)).toBe(16_384);
    expect(nextReviewOutputTokens(8192)).toBe(16_384);
    expect(nextReviewOutputTokens(24_000)).toBe(32_768);
  });

  it("never increases beyond an explicit review ceiling or repeats the same allowance", () => {
    expect(initialReviewOutputTokens(100, 1024)).toBe(1024);
    expect(nextReviewOutputTokens(8192, 8192)).toBeUndefined();
    expect(nextReviewOutputTokens(8192, 10_000)).toBe(10_000);
    expect(nextReviewOutputTokens(32_768)).toBeUndefined();
    expect(nextReviewOutputTokens(40_000, 32_768)).toBeUndefined();
  });

  it("caps each request by model output support and remaining context", () => {
    const model = descriptor({ providerId: "fake", modelId: "small", displayName: "Small", maxContextTokens: 16_000 });
    model.capabilities.maxOutputTokens = 4000;
    expect(resolveRequestOutputTokens({ model, maxOutputTokens: 8192, estimatedInputTokens: 1000 })).toBe(4000);
    expect(resolveRequestOutputTokens({ model, maxOutputTokens: 2000, estimatedInputTokens: 1000 })).toBe(2000);
    expect(resolveRequestOutputTokens({ model, maxOutputTokens: 8192, estimatedInputTokens: 14_000 })).toBe(1000);
    expect(() => resolveRequestOutputTokens({ model, maxOutputTokens: 8192, estimatedInputTokens: 15_000 })).toThrow("context_budget_exceeded");
  });

  it("sends the model-supported main limit and records its configured ceiling", async () => {
    const model = descriptor({ providerId: "fake", modelId: "bounded", displayName: "Bounded" });
    model.capabilities.maxOutputTokens = 2048;
    const requests: ModelRequest[] = [], timings: RequestTiming[] = [];
    const provider: ModelProvider = { id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; }, async *stream(request) { requests.push(request); yield { type: "text_delta", delta: "done" }; } };
    const result = await runWithPiAgent({
      runId: "bounded-main", sessionId: "bounded-main", model, provider,
      initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: "Answer briefly." }] }],
      contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 50_000, parallelToolCalls: false,
      beforeToolCall: async () => undefined, executeTool: async () => ({ output: "unused" }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onModelRequestFinished: timing => timings.push(timing),
    });
    expect(result.errorMessage).toBeUndefined();
    expect(requests[0]!.maxOutputTokens).toBe(2048);
    expect(timings[0]).toMatchObject({ purpose: "main", succeeded: true, maxOutputTokens: 2048, configuredMaxOutputTokens: 50_000, attempt: 1 });
  });
});
