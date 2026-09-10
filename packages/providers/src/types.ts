import type { AgentEvent, AttachmentRef, ModelDescriptor, ModelRequest, Profile, ToolCall, Usage } from "@harness/protocol";

export interface ResolvedAttachment {
  mimeType: string;
  base64: string;
}

export type AttachmentResolver = (attachment: AttachmentRef) => Promise<ResolvedAttachment>;

export interface ProviderStreamEvent {
  type: "text_delta" | "tool_call" | "usage" | "reasoning_summary" | "reasoning_delta";
  delta?: string;
  toolCall?: ToolCall;
  usage?: Usage;
  summary?: string;
}

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelDescriptor[]>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  health(signal?: AbortSignal): Promise<boolean>;
  estimateCost(model: ModelDescriptor, inputTokens: number, outputTokens: number): number;
}

export interface RouteRequirements {
  needsVision: boolean;
  needsTools: boolean;
  needsStructuredOutput: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface RouteDecision {
  provider: ModelProvider;
  model: ModelDescriptor;
  estimatedUsd: number;
  reason: string;
  score: number;
}

export interface ProviderFactoryOptions {
  attachmentResolver: AttachmentResolver;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function providerEventToAgentEvent(
  event: ProviderStreamEvent,
  base: Pick<AgentEvent, "id" | "runId" | "at" | "sequence">
): AgentEvent {
  switch (event.type) {
    case "reasoning_delta":
      throw new Error("Private reasoning must be retained in model history, never converted to a UI event");
    case "text_delta":
      return { ...base, type: "text_delta", delta: event.delta ?? "" };
    case "tool_call":
      if (!event.toolCall) throw new Error("tool_call event is missing a call");
      return { ...base, type: "tool_call", call: event.toolCall };
    case "usage":
      if (!event.usage) throw new Error("usage event is missing usage");
      return { ...base, type: "usage", usage: event.usage };
    case "reasoning_summary":
      return { ...base, type: "reasoning_summary", summary: event.summary ?? "" };
  }
}

export function routeWeights(profile: Profile): { quality: number; cost: number; latency: number } {
  const total = profile.routeWeights.quality + profile.routeWeights.cost + profile.routeWeights.latency;
  if (total <= 0) return { quality: 0.5, cost: 0.25, latency: 0.25 };
  return {
    quality: profile.routeWeights.quality / total,
    cost: profile.routeWeights.cost / total,
    latency: profile.routeWeights.latency / total
  };
}

