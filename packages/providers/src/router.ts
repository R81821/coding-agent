import type { ModelDescriptor, Profile } from "@harness/protocol";
import type { ModelProvider, RouteDecision, RouteRequirements } from "./types.js";
import { routeWeights } from "./types.js";

export class ModelRouter {
  constructor(private readonly providers: ModelProvider[]) {}

  async route(profile: Profile, requirements: RouteRequirements): Promise<RouteDecision> {
    const weights = routeWeights(profile);
    const candidates: RouteDecision[] = [];
    for (const provider of this.providers) {
      if (!profile.allowedProviders.includes(provider.id)) continue;
      for (const model of await provider.listModels()) {
        if (!model.healthy) continue;
        if (requirements.needsVision && !model.capabilities.vision) continue;
        if (requirements.needsTools && !model.capabilities.tools) continue;
        if (requirements.needsStructuredOutput && !model.capabilities.structuredOutput) continue;
        if (model.capabilities.maxContextTokens < requirements.estimatedInputTokens + requirements.estimatedOutputTokens) continue;
        const estimatedUsd = provider.estimateCost(model, requirements.estimatedInputTokens, requirements.estimatedOutputTokens);
        if (estimatedUsd > profile.budget.maxUsd) continue;
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
    if (!decision) throw new Error("No authorized healthy model satisfies this run's capabilities and budget");
    return decision;
  }
}

export function descriptor(input: Partial<ModelDescriptor> & Pick<ModelDescriptor, "providerId" | "modelId" | "displayName">): ModelDescriptor {
  return {
    capabilities: {
      vision: true,
      tools: true,
      parallelTools: true,
      structuredOutput: true,
      maxContextTokens: 128_000,
      dataPolicy: input.providerId === "openai-compatible" ? "local" : input.providerId === "gateway" ? "gateway" : "cloud"
    },
    qualityScore: 0.8,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    latencyScore: 0.7,
    healthy: true,
    ...input
  };
}

