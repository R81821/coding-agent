import type { ModelDescriptor, Profile } from "@harness/protocol";
import type { ModelProvider, RouteDecision, RouteRequirements } from "./types.js";
import { routeWeights } from "./types.js";

export class ModelRouter {
  constructor(private readonly providers: ModelProvider[]) {}

  async route(profile: Profile, requirements: RouteRequirements): Promise<RouteDecision> {
    const capacityInputTokens = requirements.minimumInputTokens ?? requirements.estimatedInputTokens;
    if (requirements.minimumInputTokens !== undefined && (
      !Number.isFinite(capacityInputTokens) || capacityInputTokens < 0 ||
      !Number.isFinite(requirements.estimatedInputTokens) || capacityInputTokens > requirements.estimatedInputTokens
    )) throw new Error("最小输入估算必须为非负有限数，且不能超过总输入估算");
    const weights = routeWeights(profile);
    const candidates: RouteDecision[] = [];
    const exclusions: string[] = [];
    const allowed = this.providers.filter(provider => profile.allowedProviders.includes(provider.id));
    const discovered = new Map<ModelProvider, ModelDescriptor[] | undefined>();
    let nextProvider = 0;
    await Promise.all(Array.from({ length: Math.min(4, allowed.length) }, async () => {
      while (nextProvider < allowed.length) {
        const provider = allowed[nextProvider++]!;
        try { discovered.set(provider, await provider.listModels()); }
        catch { discovered.set(provider, undefined); }
      }
    }));
    // Score in configured order, independent of lookup completion order.
    for (const provider of this.providers) {
      if (!profile.allowedProviders.includes(provider.id)) { exclusions.push(`${provider.id}: 当前 Profile 未授权此服务商`); continue; }
      const models = discovered.get(provider);
      if (!models) { exclusions.push(`${provider.id}: 模型列表查询失败`); continue; }
      if (!models.length) exclusions.push(`${provider.id}: 未提供模型列表`);
      for (const model of models) {
        const reasons: string[] = [];
        if (!model.healthy) reasons.push("模型被标记为不可用");
        if (requirements.needsVision && !model.capabilities.vision) reasons.push("不支持图片输入");
        if (requirements.needsTools && !model.capabilities.tools) reasons.push("不支持工具调用");
        if (requirements.needsStructuredOutput && !model.capabilities.structuredOutput) reasons.push("不支持结构化输出");
        const requiredTokens = capacityInputTokens + requirements.estimatedOutputTokens;
        if (model.capabilities.maxContextTokens < requiredTokens) reasons.push(`上下文容量不足：需要 ${requiredTokens}，上限 ${model.capabilities.maxContextTokens} tokens`);
        const estimatedUsd = provider.estimateCost(model, requirements.estimatedInputTokens, requirements.estimatedOutputTokens);
        if (estimatedUsd > profile.budget.maxUsd) reasons.push(`预计费用 $${estimatedUsd.toFixed(4)} 超过预算 $${profile.budget.maxUsd}`);
        if (reasons.length) { exclusions.push(`${provider.id}/${model.modelId}: ${reasons.join("；")}`); continue; }
        const preferredBoost = profile.preferredModels.includes(model.modelId) ? 0.12 : 0;
        const costScore = 1 / (1 + estimatedUsd * 10);
        const score = model.qualityScore * weights.quality + costScore * weights.cost + model.latencyScore * weights.latency + preferredBoost;
        candidates.push({
          provider,
          model,
          estimatedUsd,
          score,
          reason: `capability match; quality=${model.qualityScore.toFixed(2)}, cost=${costScore.toFixed(2)}, latency=${model.latencyScore.toFixed(2)}`
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.estimatedUsd - b.estimatedUsd);
    const decision = candidates[0];
    if (!decision) {
      const detail = this.providers.length === 0
        ? "后台未加载任何模型服务商。请在设置中保存 API Key；使用 OpenAI-compatible 时还须保存 Base URL 和模型名称。"
        : exclusions.slice(0, 12).join("\n");
      throw new Error(`无法选择模型：${detail}`);
    }
    // Effort can reject the normal routing decision, never change which model wins.
    if (requirements.reasoningEffort != null && !decision.model.capabilities.reasoningEfforts?.includes(requirements.reasoningEffort)) {
      throw new Error(`当前配置模型 ${decision.provider.id}/${decision.model.modelId} 不支持推理等级：${requirements.reasoningEffort}`);
    }
    return decision;
  }
}

export function descriptor(input: Partial<ModelDescriptor> & Pick<ModelDescriptor, "providerId" | "modelId" | "displayName"> & { maxContextTokens?: number; maxOutputTokens?: number }): ModelDescriptor {
  const { maxContextTokens = 128_000, maxOutputTokens, ...modelInput } = input;
  return {
    capabilities: {
      vision: true,
      tools: true,
      parallelTools: true,
      structuredOutput: true,
      maxContextTokens,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      dataPolicy: input.providerId === "openai-compatible" ? "local" : input.providerId === "gateway" ? "gateway" : "cloud"
    },
    pricingKnown: input.pricingKnown ?? (input.inputUsdPerMillion !== undefined && input.outputUsdPerMillion !== undefined),
    qualityScore: 0.8,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    latencyScore: 0.7,
    healthy: true,
    ...modelInput
  };
}

