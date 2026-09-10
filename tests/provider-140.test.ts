import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, OpenAIProvider, descriptor } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
const model = descriptor({ providerId: "compatible", modelId: "fixture", displayName: "fixture" });
const request = (): ModelRequest => ({ runId: "run", model, messages: [{ role: "user", content: [{ type: "text", text: "hello", trust: "user_request" }] }], tools: [], maxOutputTokens: 2048, parallelToolCalls: false, store: false });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
const done = () => sse([{ type: "response.completed", response: { id: "resp" } }]);
async function collect(provider: OpenAICompatibleProvider | OpenAIProvider, req = request()) { const events = []; for await (const event of provider.stream(req, new AbortController().signal)) events.push(event); return events; }
describe("1.4.0 provider wire contracts", () => {
  it.each([
    [OpenAICompatibleProvider, "https://custom.test/v1", undefined, "/chat/completions", "max_tokens"],
    [OpenAICompatibleProvider, "https://custom.test/v1", "responses", "/responses", "max_output_tokens"],
    [OpenAICompatibleProvider, "https://api.deepseek.com", undefined, "/responses", "max_output_tokens"],
    [OpenAICompatibleProvider, "https://api.deepseek.com", "chat_completions", "/chat/completions", "max_tokens"],
    [OpenAIProvider, "https://custom.test/v1", "chat_completions", "/chat/completions", "max_tokens"]
  ] as const)("routes protocol case %# and transmits the output limit", async (Provider, baseUrl, apiProtocol, endpoint, limitField) => {
    let url = ""; let body: Record<string, any> = {};
    const provider = new Provider({ id: "fixture", apiKey: "fixture", baseUrl, models: [model], resolveAttachment: async () => { throw Error("unused"); }, ...(apiProtocol ? { apiProtocol } : {}), fetchImpl: async (target, init) => { url = String(target); body = JSON.parse(String(init?.body)); return done(); } });
    await collect(provider);
    expect(url).toBe(baseUrl + endpoint);
    expect(body[limitField]).toBe(2048);
    expect(body.store).not.toBe(true);
  });
  it("returns reasoning privately and replays it separately on every assistant history message", async () => {
    const bodies: Record<string, any>[] = [];
    const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "fixture", baseUrl: "https://custom.test", models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse([{ choices: [{ delta: { reasoning_content: "private reasoning", content: "answer" } }] }]); } });
    const events = await collect(provider);
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "private reasoning" });
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", delta: "answer" }]);
    await collect(provider, { ...request(), messages: [...request().messages, { role: "assistant", reasoningContent: "private reasoning", content: [{ type: "text", text: "answer", trust: "untrusted_tool" }, { type: "tool_call", toolCallId: "call", name: "read_file", input: {} }] }, { role: "tool", content: [{ type: "tool_result", toolCallId: "call", output: "data", trust: "untrusted_tool" }] }] });
    expect(bodies[1]?.messages[1]?.reasoning_content).toBe("private reasoning");
    expect(JSON.stringify(bodies[1]?.messages[1]?.content)).not.toContain("private reasoning");
  });
  it("does not invent absent optional usage and preserves reported reasoning", async () => {
    const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "fixture", baseUrl: "https://custom.test", models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async () => sse([{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 6 } } }]) });
    const events = await collect(provider);
    expect(events[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 8, reasoningTokens: 6 });
    expect(events[0]?.usage?.cachedInputTokens).toBeUndefined();
    expect(events[0]?.usage?.costKnown).toBe(false);
  });
});

describe("1.4.0 Responses interrupted continuation", () => {
  it.each(["network", "consumer-return", "output-error"])("invalidates response IDs after %s without replay", async mode => {
    const bodies: Record<string, any>[] = [];
    const provider = new OpenAIProvider({ id: "fixture", apiKey: "fixture", baseUrl: "https://fixture.test", models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 2 && mode === "network") throw Error("network failed");
      return sse([{ type: "response.output_text.delta", delta: "hi" }, ...(bodies.length === 2 && mode === "output-error" ? [{ type: "error", error: { code: "previous_response_not_found" } }] : [{ type: "response.completed", response: { id: "resp-" + bodies.length } }])]);
    } });
    const first = { ...request(), store: true };
    await collect(provider, first);
    const next: ModelRequest = { ...first, messages: [...first.messages, { role: "assistant", content: [{ type: "text", text: "hi", trust: "untrusted_tool" }] }, { role: "user", content: [{ type: "text", text: "continue", trust: "user_request" }] }] };
    if (mode === "consumer-return") {
      const stream = provider.stream(next, new AbortController().signal)[Symbol.asyncIterator]();
      expect((await stream.next()).value).toMatchObject({ type: "text_delta", delta: "hi" });
      await stream.return?.();
    } else await expect(collect(provider, next)).rejects.toThrow();
    expect(bodies).toHaveLength(2);
    await collect(provider, next);
    expect(bodies[1]?.previous_response_id).toBe("resp-1");
    expect(bodies[2]?.previous_response_id).toBeUndefined();
    expect(bodies[2]?.input).toHaveLength(3);
  });
});

describe("DeepSeek Responses compatibility", () => {
  it("keeps full context and private reasoning for its stateless Responses API", async () => {
    const bodies: Record<string, any>[] = [];
    const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "fixture", baseUrl: "https://api.deepseek.com", models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse([{ type: "response.reasoning_text.delta", delta: "thought" }, { type: "response.output_text.delta", delta: "hi" }, { type: "response.completed", response: { id: "resp" } }]);
    } });
    const first = { ...request(), store: true };
    const events = await collect(provider, first);
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "thought" });
    await collect(provider, { ...first, messages: [...first.messages, { role: "assistant", reasoningContent: "thought", content: [{ type: "text", text: "hi", trust: "untrusted_tool" }] }, { role: "user", content: [{ type: "text", text: "continue", trust: "user_request" }] }] });
    expect(bodies.every(body => body.store === false && !body.previous_response_id)).toBe(true);
    expect(bodies[1]?.input).toContainEqual({ type: "reasoning", content: [{ type: "reasoning_text", text: "thought" }] });
    expect(bodies[1]?.input[0]).toMatchObject({ role: "user", content: [{ text: "hello" }] });
  });
});
