import { describe, expect, it } from "vitest";
import { resolvePromptBackend } from "@harness/protocol";
import type { ModelProvider, ProviderFactoryOptions } from "@harness/providers";
import { createConfiguredProviders, descriptor, OpenAICompatibleProvider, OpenAIProvider } from "@harness/providers";

const attachmentResolver: ProviderFactoryOptions["attachmentResolver"] = async () => { throw new Error("unused"); };
const configured = (env: NodeJS.ProcessEnv) => createConfiguredProviders({ env, attachmentResolver });
const compatible = {
  OPENAI_COMPATIBLE_BASE_URL: "https://proxy.example/v1",
  OPENAI_COMPATIBLE_MODEL: "deepseek-flash",
};

describe("prompt backend configuration", () => {
  it.each([
    ["https://api.deepseek.com", "dsh"],
    ["https://api.deepseek.com/", "dsh"],
    ["https://api.deepseek.com/v1", "dsh"],
    ["https://api.deepseek.com/v1/", "dsh"],
    ["https://api.deepseek.com:443/v1", "dsh"],
    ["https://api.openai.com/v1", "harness"],
    ["https://api.deepseek.com.evil.example/v1", "harness"],
    ["https://deepseek.api.example/v1", "harness"],
    ["https://api.deepseek.com:8443/v1", "harness"],
    ["http://api.deepseek.com/v1", "harness"],
    ["https://api.deepseek.com/custom", "harness"],
    ["https://user@api.deepseek.com/v1", "harness"],
    ["", "harness"],
    ["not a URL", "harness"],
  ])("resolves %s to %s in auto mode", (baseUrl, expected) => {
    expect(resolvePromptBackend(baseUrl!)).toBe(expected);
  });

  it("allows explicit backend choice without claiming official API capabilities", () => {
    const proxy = configured({ ...compatible, OPENAI_COMPATIBLE_PROMPT_BACKEND: "dsh" })[0]!;
    expect(proxy.promptBackend).toBe("dsh");
    expect(proxy.supportsNonThinkingCompaction?.()).toBe(false);
    expect(configured({
      ...compatible,
      OPENAI_COMPATIBLE_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_COMPATIBLE_PROMPT_BACKEND: "harness",
    })[0]!.promptBackend).toBe("harness");
  });

  it("binds the loaded configuration once and keeps simultaneous providers independent", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "fixture",
      ...compatible,
      OPENAI_COMPATIBLE_BASE_URL: "https://api.deepseek.com/v1",
    };
    const first = configured(env);
    expect(first.map(provider => [provider.id, provider.promptBackend])).toEqual([
      ["openai", "harness"], ["openai-compatible", "dsh"],
    ]);
    env.OPENAI_COMPATIBLE_BASE_URL = "https://proxy.example/v1";
    expect(first[1]!.promptBackend).toBe("dsh");
    expect(configured(env)[1]!.promptBackend).toBe("harness");
  });

  it("does not infer a backend from provider or model names", async () => {
    const provider = configured(compatible)[0]!;
    expect((await provider.listModels())[0]!.modelId).toBe("deepseek-flash");
    expect(provider.promptBackend).toBe("harness");
    const model = descriptor({ providerId: "custom", modelId: "alias", displayName: "Alias" });
    const config = { id: "custom", apiKey: "fixture", baseUrl: "https://api.deepseek.com/v1", models: [model], resolveAttachment: attachmentResolver };
    expect(new OpenAICompatibleProvider(config).promptBackend).toBe("dsh");
    expect(new OpenAIProvider(config).promptBackend).toBe("dsh");
  });

  it.each([
    { id: "openai", prefix: "OPENAI", env: { OPENAI_API_KEY: "fixture" } },
    { id: "anthropic", prefix: "ANTHROPIC", env: { ANTHROPIC_API_KEY: "fixture" } },
    { id: "gemini", prefix: "GEMINI", env: { GEMINI_API_KEY: "fixture" } },
    { id: "openai-compatible", prefix: "OPENAI_COMPATIBLE", env: compatible },
    { id: "gateway", prefix: "HARNESS_GATEWAY", env: { HARNESS_GATEWAY_URL: "https://proxy.example", HARNESS_GATEWAY_TOKEN: "fixture", HARNESS_GATEWAY_MODEL: "fixture" } },
  ])("reads and validates $id backend settings", ({ id, prefix, env }) => {
    expect(configured({ ...env, [`${prefix}_PROMPT_BACKEND`]: "dsh" }).find(provider => provider.id === id)!.promptBackend).toBe("dsh");
    expect(configured({ ...env, [`${prefix}_PROMPT_BACKEND`]: "auto" }).find(provider => provider.id === id)!.promptBackend).toBe("harness");
    expect(() => configured({ ...env, [`${prefix}_PROMPT_BACKEND`]: "other" })).toThrow(/prompt backend/i);
  });

  it("retains compatibility with providers that do not declare a backend", () => {
    const provider: ModelProvider = {
      id: "fixture", listModels: async () => [], health: async () => true, estimateCost: () => 0,
      async *stream() { yield { type: "text_delta", delta: "fixture" }; },
    };
    expect(provider.promptBackend ?? "harness").toBe("harness");
  });
});
