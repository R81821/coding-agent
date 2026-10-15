import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider } from "./adapters.js";
import { descriptor, ModelRouter } from "./router.js";
import type { ApiProtocol } from "./adapters.js";
import type { ModelProvider, ProviderFactoryOptions } from "./types.js";

export * from "./types.js";
export * from "./router.js";
export * from "./adapters.js";
export * from "./parallel-search.js";
export * from "./tool-history.js";
export * from "./reasoning.js";

export function createConfiguredProviders(options: ProviderFactoryOptions): ModelProvider[] {
  const env = options.env ?? process.env;
  const providers: ModelProvider[] = [];
  if (env.OPENAI_API_KEY) {
    providers.push(
      new OpenAIProvider({
        id: "openai",
        ...protocolOption(env.OPENAI_API_PROTOCOL),
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        resolveAttachment: options.attachmentResolver,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: [
          descriptor({ ...contextOption(env.OPENAI_MAX_CONTEXT_TOKENS), providerId: "openai", modelId: env.OPENAI_MODEL ?? "gpt-5.4", displayName: "OpenAI", qualityScore: 0.95, latencyScore: 0.72, inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 })
        ]
      })
    );
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.push(
      new AnthropicProvider({
        id: "anthropic",
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
        resolveAttachment: options.attachmentResolver,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: [descriptor({ ...contextOption(env.ANTHROPIC_MAX_CONTEXT_TOKENS), providerId: "anthropic", modelId: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6", displayName: "Anthropic Claude", qualityScore: 0.93, latencyScore: 0.7, inputUsdPerMillion: 3, outputUsdPerMillion: 15 })]
      })
    );
  }
  if (env.GEMINI_API_KEY) {
    providers.push(
      new GeminiProvider({
        id: "gemini",
        apiKey: env.GEMINI_API_KEY,
        baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
        resolveAttachment: options.attachmentResolver,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: [descriptor({ ...contextOption(env.GEMINI_MAX_CONTEXT_TOKENS), providerId: "gemini", modelId: env.GEMINI_MODEL ?? "gemini-2.5-pro", displayName: "Google Gemini", qualityScore: 0.9, latencyScore: 0.78, inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 })]
      })
    );
  }
  if (env.OPENAI_COMPATIBLE_BASE_URL && env.OPENAI_COMPATIBLE_MODEL) {
    providers.push(
      new OpenAICompatibleProvider({
        id: "openai-compatible",
        ...protocolOption(env.OPENAI_COMPATIBLE_API_PROTOCOL),
        apiKey: env.OPENAI_COMPATIBLE_API_KEY ?? "local",
        baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
        resolveAttachment: options.attachmentResolver,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: [descriptor({ ...contextOption(env.OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS), providerId: "openai-compatible", modelId: env.OPENAI_COMPATIBLE_MODEL, displayName: "OpenAI-compatible", qualityScore: Number(env.OPENAI_COMPATIBLE_QUALITY ?? 0.75), latencyScore: Number(env.OPENAI_COMPATIBLE_LATENCY ?? 0.8) })]
      })
    );
  }
  if (env.HARNESS_GATEWAY_URL && env.HARNESS_GATEWAY_TOKEN && env.HARNESS_GATEWAY_MODEL) {
    providers.push(
      new OpenAICompatibleProvider({
        id: "gateway",
        ...protocolOption(env.HARNESS_GATEWAY_API_PROTOCOL),
        apiKey: env.HARNESS_GATEWAY_TOKEN,
        baseUrl: `${env.HARNESS_GATEWAY_URL.replace(/\/$/, "")}/v1`,
        resolveAttachment: options.attachmentResolver,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        models: [descriptor({ ...contextOption(env.HARNESS_GATEWAY_MAX_CONTEXT_TOKENS), providerId: "gateway", modelId: env.HARNESS_GATEWAY_MODEL, displayName: "Team Gateway", qualityScore: 0.85, latencyScore: 0.65 })]
      })
    );
  }
  return providers;
}

export function createRouter(options: ProviderFactoryOptions): ModelRouter {
  return new ModelRouter(createConfiguredProviders(options));
}

function protocolOption(value: string | undefined): { apiProtocol?: ApiProtocol } {
  if (!value || value === "auto") return {};
  if (value !== "chat_completions" && value !== "responses") throw new Error("API protocol must be chat_completions or responses");
  return { apiProtocol: value };
}

function contextOption(value: string | undefined): { maxContextTokens?: number } {
  if (!value) return {};
  const capacity = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Model context capacity must be a positive integer");
  return { maxContextTokens: capacity };
}
