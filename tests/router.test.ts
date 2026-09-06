import { describe, expect, it } from "vitest";
import { ModelRouter, descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, type ModelRequest } from "@harness/protocol";

function provider(id: string, vision: boolean, quality: number, price: number): ModelProvider {
  const model = descriptor({
    providerId: id,
    modelId: `${id}-model`,
    displayName: id,
    capabilities: { vision, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128_000, dataPolicy: "cloud" },
    qualityScore: quality,
    latencyScore: 0.7,
    inputUsdPerMillion: price,
    outputUsdPerMillion: price
  });
  return {
    id,
    async listModels() { return [model]; },
    async *stream(_request: ModelRequest): AsyncIterable<ProviderStreamEvent> { yield { type: "text_delta", delta: "ok" }; },
    async health() { return true; },
    estimateCost(_model, input, output) { return (input + output) * price / 1_000_000; }
  };
}

describe("model router", () => {
  const requirements = { needsVision: false, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, estimatedOutputTokens: 500 };
  it("explains missing provider configuration without blaming model health", async () => {
    await expect(new ModelRouter([]).route(DEFAULT_PROFILE, requirements)).rejects.toThrow("后台未加载任何模型服务商");
  });
  it("explains authorization, capability, context and budget exclusions", async () => {
    const modelProvider = provider("fixture", false, 0.8, 1);
    const router = new ModelRouter([modelProvider]);
    await expect(router.route(DEFAULT_PROFILE, requirements)).rejects.toThrow("未授权");
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fixture"] };
    await expect(router.route(profile, { ...requirements, needsVision: true })).rejects.toThrow("不支持图片输入");
    await expect(router.route(profile, { ...requirements, estimatedInputTokens: 128000 })).rejects.toThrow("上下文容量不足");
    await expect(router.route({ ...profile, budget: { ...profile.budget, maxUsd: 0 } }, requirements)).rejects.toThrow("超过预算");
  });

  it("hard-filters non-vision providers before applying weighted scoring", async () => {
    const router = new ModelRouter([provider("cheap-text", false, 1, 0), provider("vision", true, 0.8, 2)]);
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["cheap-text", "vision"] };
    const route = await router.route(profile, { needsVision: true, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1_000, estimatedOutputTokens: 500 });
    expect(route.provider.id).toBe("vision");
    expect(route.reason).toContain("capability match");
  });

  it("does not route to providers outside the profile allow-list", async () => {
    const router = new ModelRouter([provider("allowed", true, 0.5, 1), provider("blocked", true, 1, 0)]);
    const route = await router.route({ ...DEFAULT_PROFILE, allowedProviders: ["allowed"] }, { needsVision: false, needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 10, estimatedOutputTokens: 10 });
    expect(route.provider.id).toBe("allowed");
  });
});

