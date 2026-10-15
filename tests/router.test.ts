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

  it("admits compactable conversation history while retaining full input for pricing", async () => {
    const modelProvider = provider("fixture", true, 0.8, 1);
    const measured: Array<{ input: number; output: number }> = [];
    modelProvider.estimateCost = (_model, input, output) => {
      measured.push({ input, output });
      return (input + output) / 1_000_000;
    };
    const router = new ModelRouter([modelProvider]);
    const profile = { ...DEFAULT_PROFILE, allowedProviders: [modelProvider.id] };
    const largeConversation = { ...requirements, estimatedInputTokens: 500_000 };
    await expect(router.route(profile, largeConversation)).rejects.toThrow("上下文容量不足");
    measured.length = 0;

    const route = await router.route(profile, { ...largeConversation, minimumInputTokens: 3_000 });
    expect(route.provider).toBe(modelProvider);
    expect(measured).toEqual([{ input: 500_000, output: 500 }]);
    expect(route.estimatedUsd).toBe(0.5005);
    await expect(router.route({ ...profile, budget: { ...profile.budget, maxUsd: 0.1 } }, { ...largeConversation, minimumInputTokens: 3_000 })).rejects.toThrow("超过预算");
  });

  it("requires the noncompressible request and output to fit the selected model", async () => {
    const modelProvider = provider("fixture", true, 0.8, 0);
    const router = new ModelRouter([modelProvider]);
    const profile = { ...DEFAULT_PROFILE, allowedProviders: [modelProvider.id] };
    const largeConversation = { ...requirements, estimatedInputTokens: 500_000 };
    await expect(router.route(profile, { ...largeConversation, minimumInputTokens: 127_501 })).rejects.toThrow("需要 128001，上限 128000 tokens");
    expect((await router.route(profile, { ...largeConversation, minimumInputTokens: 127_500 })).provider).toBe(modelProvider);
  });

  it.each([-1, Infinity, NaN, 1_001])("rejects an invalid minimum input estimate %s", async minimumInputTokens => {
    const modelProvider = provider("fixture", true, 0.8, 0);
    await expect(new ModelRouter([modelProvider]).route({ ...DEFAULT_PROFILE, allowedProviders: [modelProvider.id] }, { ...requirements, minimumInputTokens })).rejects.toThrow("最小输入估算");
  });

  it("retains normal scoring and rejects unsupported reasoning after routing compactable history", async () => {
    const configured = provider("configured", true, 1, 0);
    const supporting = provider("supporting", true, 0.1, 0);
    (await configured.listModels())[0]!.capabilities.reasoningEfforts = ["low"];
    (await supporting.listModels())[0]!.capabilities.reasoningEfforts = ["high"];
    const profile = { ...DEFAULT_PROFILE, allowedProviders: [configured.id, supporting.id] };
    const router = new ModelRouter([configured, supporting]);
    const compactable = { ...requirements, estimatedInputTokens: 500_000, minimumInputTokens: 3_000 };
    expect((await router.route(profile, compactable)).provider).toBe(configured);
    await expect(router.route(profile, { ...compactable, reasoningEffort: "high" as const })).rejects.toThrow("当前配置模型 configured/configured-model 不支持推理等级");
  });
});



describe("parallel model discovery", () => {
  const requirements = { needsVision: false, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, estimatedOutputTokens: 500 };
  it("continues routing when one provider's model lookup fails", async () => {
    const broken = provider("broken", true, 1, 0);
    broken.listModels = async () => { throw new Error("lookup failed"); };
    const healthy = provider("healthy", true, 0.8, 0);
    const router = new ModelRouter([broken, healthy]);
    const result = await router.route({ ...DEFAULT_PROFILE, allowedProviders: ["broken", "healthy"] }, requirements);
    expect(result.provider.id).toBe("healthy");
    await expect(new ModelRouter([broken]).route({ ...DEFAULT_PROFILE, allowedProviders: ["broken"] }, requirements)).rejects.toThrow(/broken.*模型列表/);
  });

  it("bounds simultaneous lookups and retains deterministic tie ordering", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, maximum = 0;
    const started: string[] = [];
    const providers = Array.from({ length: 9 }, (_, index) => {
      const entry = provider(String(index), true, 0.8, 0);
      const listModels = entry.listModels;
      entry.listModels = async () => {
        active++;
        maximum = Math.max(maximum, active);
        started.push(entry.id);
        await gate;
        active--;
        return listModels();
      };
      return entry;
    });
    const blocked = provider("blocked", true, 1, 0);
    blocked.listModels = async () => { started.push("blocked"); throw new Error("unauthorized"); };
    const pending = new ModelRouter([...providers, blocked]).route({ ...DEFAULT_PROFILE, allowedProviders: providers.map(item => item.id) }, requirements);
    await new Promise<void>(done => setImmediate(done));
    const initialStarted = started.length;
    release();
    const result = await pending;
    expect(initialStarted).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(started).not.toContain("blocked");
    expect(started).toHaveLength(9);
    expect(result.provider.id).toBe("0");
  });
});
