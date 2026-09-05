import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  descriptor,
  normalizeToolMessageSequence,
} from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";

const encoder = new TextEncoder();
function emptyStream(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); } }), { status: 200 });
}
function fixture(providerId: string): ModelRequest {
  const model = descriptor({ providerId, modelId: "model", displayName: "model" });
  return { runId: "run", model, messages: [
    { role: "user", content: [{ type: "text", text: "inspect", trust: "user_request" }] },
    { role: "assistant", content: [{ type: "tool_call", toolCallId: "call-1", name: "read_file", input: { path: "a.ts" } }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", output: { text: "ok" }, trust: "untrusted_tool" }] }
  ], tools: [], maxOutputTokens: 100, parallelToolCalls: true, store: false };
}

describe("native provider tool history", () => {
  it("repairs orphaned and incomplete tool history before provider submission", () => {
    const repaired = normalizeToolMessageSequence([
      { role: "user", content: [{ type: "text", text: "inspect", trust: "user_request" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "orphan", output: { text: "preserve me" }, trust: "untrusted_tool" }] },
      { role: "assistant", content: [
        { type: "tool_call", toolCallId: "complete", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_call", toolCallId: "missing", name: "read_file", input: { path: "b.ts" } },
      ] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "complete", output: { text: "ok" }, trust: "untrusted_tool" }] },
    ]);
    expect(repaired[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(repaired[1])).toContain("preserve me");
    expect(JSON.stringify(repaired)).toContain("complete");
    expect(JSON.stringify(repaired)).not.toContain("missing");
    const formalResults = repaired.flatMap((message) =>
      message.role === "tool" ? message.content : [],
    );
    expect(formalResults).toHaveLength(1);
  });

  it("maps Anthropic tool_use/tool_result blocks", async () => {
    let body: any;
    const request = fixture("anthropic");
    const provider = new AnthropicProvider({ id: "anthropic", apiKey: "key", baseUrl: "https://a.test", models: [request.model], resolveAttachment: async () => { throw new Error("unused"); }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return emptyStream(); } });
    for await (const _event of provider.stream(request, new AbortController().signal)) { /* drain */ }
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "call-1", name: "read_file" });
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-1" });
  });

  it("maps Gemini functionCall/functionResponse blocks", async () => {
    let body: any;
    const request = fixture("gemini");
    const provider = new GeminiProvider({ id: "gemini", apiKey: "key", baseUrl: "https://g.test", models: [request.model], resolveAttachment: async () => { throw new Error("unused"); }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return emptyStream(); } });
    for await (const _event of provider.stream(request, new AbortController().signal)) { /* drain */ }
    expect(body.contents[1].parts[0]).toMatchObject({ functionCall: { name: "read_file" } });
    expect(body.contents[2].parts[0]).toMatchObject({ functionResponse: { name: "read_file" } });
  });

  it("maps OpenAI-compatible assistant/tool messages", async () => {
    let body: any;
    const request = fixture("openai-compatible");
    const provider = new OpenAICompatibleProvider({ id: "openai-compatible", apiKey: "key", baseUrl: "https://c.test", models: [request.model], resolveAttachment: async () => { throw new Error("unused"); }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return emptyStream(); } });
    for await (const _event of provider.stream(request, new AbortController().signal)) { /* drain */ }
    expect(body.messages[1].tool_calls[0]).toMatchObject({ id: "call-1", function: { name: "read_file" } });
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
  });

  it("never submits an orphan role=tool message to an OpenAI-compatible API", async () => {
    let body: any;
    const request = fixture("openai-compatible");
    request.messages = [
      request.messages[0]!,
      { role: "tool", content: [{ type: "tool_result", toolCallId: "orphan", output: { text: "data" }, trust: "untrusted_tool" }] },
    ];
    const provider = new OpenAICompatibleProvider({ id: "openai-compatible", apiKey: "key", baseUrl: "https://c.test", models: [request.model], resolveAttachment: async () => { throw new Error("unused"); }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return emptyStream(); } });
    for await (const _event of provider.stream(request, new AbortController().signal)) { /* drain */ }
    expect(body.messages.some((message: { role?: string }) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(body.messages)).toContain("Recovered orphaned tool output");
  });
});
