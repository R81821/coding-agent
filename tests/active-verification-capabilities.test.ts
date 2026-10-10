import { expect, it } from "vitest";
import { descriptor, ProviderOutputTruncatedError, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { timedProviderStream, type RequestTiming } from "../packages/core/src/model-request.js";

it("preserves measured reasoning usage and failed request diagnostics on output truncation", async () => {
  const model = descriptor({ providerId: "fake", modelId: "main", displayName: "Main" });
  const request: ModelRequest = { runId: "main", purpose: "main", model, messages: [], tools: [], maxOutputTokens: 8192, parallelToolCalls: false, store: false };
  const measured: ProviderStreamEvent = { type: "usage", usage: { inputTokens: 50, outputTokens: 8192, reasoningTokens: 8192, estimatedUsd: .03, costKnown: false } };
  const observed: ProviderStreamEvent[] = [], timings: RequestTiming[] = [], requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(value) {
      requests.push(value);
      yield measured;
      throw new ProviderOutputTruncatedError("max_output_tokens");
    },
  };
  const consume = async () => {
    for await (const event of timedProviderStream(provider, request, new AbortController().signal, value => timings.push(value), { configuredMaxOutputTokens: 16_384, attempt: 1 })) observed.push(event);
  };
  await expect(consume()).rejects.toBeInstanceOf(ProviderOutputTruncatedError);
  expect(requests).toEqual([request]);
  expect(observed).toEqual([measured]);
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ purpose: "main", succeeded: false, maxOutputTokens: 8192, configuredMaxOutputTokens: 16_384, attempt: 1, errorCode: "provider_output_truncated" });
});

it("retains requirements beyond the twentieth line and 3000 characters", () => {
  const requirements = Array.from({ length: 25 }, (_, i) => String(i) + "x".repeat(3100));
  const workflow = new LightweightWorkflow(requirements.join("\n"), () => {});
  expect(workflow.state.requirements).toEqual(requirements);
  expect(workflow.state.requirementIds).toHaveLength(requirements.length);
});
