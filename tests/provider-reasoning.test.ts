import { describe, expect, it } from "vitest";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider, createConfiguredProviders, descriptor } from "@harness/providers";
import type { AdapterConfig, ModelProvider } from "@harness/providers";
import type { ModelDescriptor, ModelRequest, ReasoningEffort } from "@harness/protocol";

function fixture(Provider: new (config: AdapterConfig) => ModelProvider, modelId: string, options: Partial<AdapterConfig> = {}) {
  const bodies: Record<string, any>[] = [];
  const headers: HeadersInit[] = [];
  const model = descriptor({ providerId: "fixture", modelId, displayName: modelId });
  const provider = new Provider({ id: "fixture", apiKey: "test", baseUrl: "https://fixture.test/v1", models: [model], resolveAttachment: async () => { throw Error("unused"); },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
      headers.push(init?.headers ?? {});
      return new Response('data: {"type":"response.completed","response":{"id":"fixture-response"}}\n\ndata: [DONE]\n\n', { status: 200 });
    }, ...options });
  return { provider, model, bodies, headers };
}

function request(model: ModelDescriptor, reasoningEffort?: ReasoningEffort): ModelRequest {
  return { model, runId: "run", messages: [{ role: "user", content: [{ type: "text", text: "hello", trust: "user_request" }] }],
    tools: [], maxOutputTokens: 4000, parallelToolCalls: true, store: false, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

async function drain(provider: ModelProvider, input: ModelRequest) {
  for await (const _event of provider.stream(input, new AbortController().signal)) { /* consume actual stream */ }
}

describe("configured reasoning capabilities", () => {
  it("lists actual configured models with documented efforts, and leaves unknown aliases unset", async () => {
    const providers = createConfiguredProviders({ env: { OPENAI_API_KEY: "test", OPENAI_MODEL: "gpt-6.1-sol", ANTHROPIC_API_KEY: "test",
      OPENAI_COMPATIBLE_BASE_URL: "https://fixture.test/v1", OPENAI_COMPATIBLE_MODEL: "private-model", GEMINI_API_KEY: "test" },
      attachmentResolver: async () => { throw Error("unused"); } });
    const models = (await Promise.all(providers.map(provider => provider.listModels()))).flat();
    expect(models.map(model => model.modelId)).toEqual(["gpt-6.1-sol", "claude-sonnet-4-6", "gemini-2.5-pro", "private-model"]);
    expect(models[0]?.capabilities.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.capabilities.reasoningEfforts).toEqual(["low", "medium", "high", "max"]);
    expect(models[2]?.capabilities.reasoningEfforts).toBeUndefined();
    expect(models[3]?.capabilities.reasoningEfforts).toBeUndefined();
  });

  it("preserves explicitly declared support, including an explicit empty list", async () => {
    const testModel = descriptor({ providerId: "fixture", modelId: "gpt-6.1-sol", displayName: "model" });
    testModel.capabilities.reasoningEfforts = [];
    const { provider } = fixture(OpenAIProvider, testModel.modelId, { models: [testModel] });
    expect((await provider.listModels())[0]?.capabilities.reasoningEfforts).toEqual([]);
  });

  it.each(["gpt-6.1-astra", "gpt-6.1-luna", "gpt-5.2-nano", "gpt-5.5-mini", "gpt-5.1-codex"])("does not invent efforts for undocumented IDs such as %s", async modelId => {
    const { provider } = fixture(OpenAIProvider, modelId);
    expect((await provider.listModels())[0]?.capabilities.reasoningEfforts).toBeUndefined();
  });
});

describe("wire reasoning effort", () => {
  it.each([OpenAIProvider, OpenAICompatibleProvider])("forwards xhigh using Responses reasoning.effort (%s)", async Provider => {
    const { provider, model, bodies } = fixture(Provider, "gpt-6.1-sol", { apiProtocol: "responses" });
    await drain(provider, request(model, "xhigh"));
    expect(bodies[0]?.reasoning).toEqual({ effort: "xhigh" });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it.each([OpenAIProvider, OpenAICompatibleProvider])("forwards Chat reasoning_effort without a Responses field (%s)", async Provider => {
    const { provider, model, bodies } = fixture(Provider, "gpt-5.4", { apiProtocol: "chat_completions" });
    await drain(provider, request(model, "high"));
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });

  it.each(["gpt-5.4", "o3", "gpt-5.4-2026-03-05"])("uses max_completion_tokens for the known OpenAI reasoning model %s", async modelId => {
    const { provider, model, bodies } = fixture(OpenAICompatibleProvider, modelId, { apiProtocol: "chat_completions" });
    await drain(provider, request(model, "high"));
    expect(bodies[0]?.max_completion_tokens).toBe(4000);
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it.each(["private-model", "deepseek-v4-pro", "gpt-private-model"])("preserves max_tokens for the compatible model %s", async modelId => {
    const { provider, model, bodies } = fixture(OpenAICompatibleProvider, modelId, { apiProtocol: "chat_completions" });
    await drain(provider, request(model));
    expect(bodies[0]?.max_tokens).toBe(4000);
    expect(bodies[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps unselected provider defaults and rejects unsupported levels before fetch", async () => {
    const { provider, model, bodies } = fixture(OpenAIProvider, "gpt-6.1-sol");
    await drain(provider, request(model));
    expect(bodies[0]).not.toHaveProperty("reasoning");
    await expect(drain(provider, request(model, "none"))).rejects.toThrow(/不支持推理等级 none/);
    expect(bodies).toHaveLength(1);
  });

  it("sends Claude effort without enabling adaptive thinking or adding a beta header", async () => {
    const { provider, model, bodies, headers } = fixture(AnthropicProvider, "claude-sonnet-4-6");
    await drain(provider, request(model, "max"));
    expect(bodies[0]?.output_config).toEqual({ effort: "max" });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(new Headers(headers[0]).get("anthropic-beta")).toBeNull();
    await expect(drain(provider, request(model, "xhigh"))).rejects.toThrow(/不支持/);
    expect(bodies).toHaveLength(1);
  });

  it("sends documented Gemini 3 thinkingLevel and rejects GenerateContent levels on Gemini 2.5", async () => {
    const current = fixture(GeminiProvider, "gemini-3.1-pro-preview");
    await drain(current.provider, request(current.model, "medium"));
    expect(current.bodies[0]?.generationConfig).toEqual({ maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: "medium" } });
    const legacy = fixture(GeminiProvider, "gemini-2.5-pro");
    await expect(drain(legacy.provider, request(legacy.model, "medium"))).rejects.toThrow(/不支持/);
    expect(legacy.bodies).toHaveLength(0);
  });

  it("gives DeepSeek compaction priority over the selected main effort", async () => {
    const { provider, model, bodies } = fixture(OpenAICompatibleProvider, "deepseek-v4-pro", { baseUrl: "https://api.deepseek.com" });
    await drain(provider, request(model, "max"));
    await drain(provider, { ...request(model, "max"), disableThinking: true, purpose: "compaction" });
    expect(bodies.map(body => body.reasoning)).toEqual([{ effort: "max" }, { effort: "none" }]);
    expect(bodies.map(body => body.store)).toEqual([false, false]);
  });

  it("controls DeepSeek Chat thinking together with effort and preserves the non-thinking compaction override", async () => {
    const { provider, model, bodies } = fixture(OpenAICompatibleProvider, "deepseek-flash", { baseUrl: "https://api.deepseek.com/v1", apiProtocol: "chat_completions" });
    await drain(provider, request(model, "high"));
    await drain(provider, request(model, "none"));
    await drain(provider, { ...request(model, "max"), disableThinking: true, purpose: "compaction" });
    expect(bodies[0]).toMatchObject({ reasoning_effort: "high", thinking: { type: "enabled" } });
    expect(bodies[1]).toMatchObject({ reasoning_effort: "none", thinking: { type: "disabled" } });
    expect(bodies[2]?.thinking).toEqual({ type: "disabled" });
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("does not carry main effort into compaction for other providers", async () => {
    const { provider, model, bodies } = fixture(OpenAIProvider, "gpt-6.1-sol");
    await drain(provider, { ...request(model, "max"), disableThinking: true, purpose: "compaction" });
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });

  it("respects GPT-6 Chat tool restrictions before making a request", async () => {
    const tool: ModelRequest["tools"][number] = { name: "read_file", description: "read", inputSchema: { type: "object" }, risk: "read", idempotent: true, timeoutMs: 1000 };
    const unsupported = fixture(OpenAICompatibleProvider, "gpt-6.1-sol");
    expect((await unsupported.provider.listModels())[0]?.capabilities.tools).toBe(false);
    await expect(drain(unsupported.provider, { ...request(unsupported.model, "high"), tools: [tool] })).rejects.toThrow(/Responses API/);
    expect(unsupported.bodies).toHaveLength(0);
    const nonThinking = fixture(OpenAICompatibleProvider, "gpt-6-sol");
    expect((await nonThinking.provider.listModels())[0]?.capabilities.reasoningEfforts).toEqual(["none"]);
    await drain(nonThinking.provider, { ...request(nonThinking.model), tools: [tool] });
    expect(nonThinking.bodies[0]?.reasoning_effort).toBe("none");
  });

  it("does not reuse a stored Responses continuation after changing effort", async () => {
    const { provider, model, bodies } = fixture(OpenAIProvider, "gpt-6.1-sol");
    const first = { ...request(model, "medium"), store: true };
    await drain(provider, first);
    await drain(provider, { ...first, reasoningEffort: "max", messages: [...first.messages,
      { role: "user", content: [{ type: "text", text: "continue", trust: "user_request" }] }] });
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]?.input).toHaveLength(2);
    expect(bodies[1]?.reasoning).toEqual({ effort: "max" });
  });
});
