import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider, descriptor, type ModelProvider } from "@harness/providers";
import { ModelMessageSchema, type AttachmentRef, type ModelMessage, type ModelRequest } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";

const screenshot: AttachmentRef = {
  id: "browser-shot", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 68,
  width: 800, height: 600, encryptedPath: "encrypted/browser-shot.blob", source: "browser",
  trust: "untrusted_web", allowedProviders: ["fixture"], createdAt: "2026-10-10T00:00:00.000Z",
};
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/QAAAABJRU5ErkJggg==";
const browser: ToolDefinition = {
  contract: { name: "browser", description: "Inspect the visible browser", inputSchema: { type: "object" }, risk: "read", idempotent: true, timeoutMs: 1000 },
  execute: async () => ({ output: null }),
};
const readFile: ToolDefinition = {
  contract: { name: "read_file", description: "Read a file", inputSchema: { type: "object" }, risk: "read", idempotent: true, timeoutMs: 1000 },
  execute: async () => ({ output: null }),
};
const imageParts = (messages: ModelMessage[]) => messages.flatMap(message => message.content.filter(part => part.type === "image"));

function fixture(input: { vision?: boolean; providerId?: string; parallelBatch?: boolean; laterRead?: boolean; initialImage?: boolean; restored?: ModelMessage[] } = {}) {
  const requests: ModelRequest[] = [];
  const model = descriptor({ providerId: input.providerId ?? "fixture", modelId: "fixture", displayName: "fixture",
    capabilities: { vision: input.vision ?? true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 64000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1 && !input.restored) {
        yield { type: "tool_call", toolCall: { id: "shot-call", name: "browser", input: { action: "screenshot", tabId: "browser-tab" } } };
        if (input.parallelBatch) yield { type: "tool_call", toolCall: { id: "read-call", name: "read_file", input: { path: "index.html" } } };
      } else if (requests.length === 2 && input.laterRead) yield { type: "tool_call", toolCall: { id: "later-read-call", name: "read_file", input: { path: "index.html" } } };
      else yield { type: "text_delta", delta: "done" };
    },
  };
  const options: PiAgentBridgeOptions = {
    runId: "run", sessionId: "session", model, provider,
    initialMessages: [{ role: "user", content: [
      { type: "text", text: "Inspect the browser screenshot", trust: "user_request" },
      ...(input.initialImage ? [{ type: "image" as const, attachment: { ...screenshot, id: "user-image", source: "file" as const }, detail: "auto" as const }] : []),
    ] }],
    contracts: [browser.contract, readFile.contract], resolveTool: name => name === "browser" ? browser : name === "read_file" ? readFile : undefined,
    externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: true,
    beforeToolCall: async () => ({}), shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    executeTool: async call => call.name === "browser"
      ? { output: { tabId: "browser-tab", url: "file:///index.html", mimeType: "image/png", width: 800, height: 600 }, images: [{ attachment: screenshot, detail: "high" }] } satisfies ToolResult
      : { output: "<html></html>" },
    ...(input.restored ? { resumeTranscript: input.restored } : {}),
  };
  return { options, requests };
}

describe("browser screenshot model images", () => {
  it("sends screenshot pixels as an untrusted image attachment alongside compact metadata", async () => {
    const { options, requests } = fixture();
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(imageParts(requests[0]!.messages)).toHaveLength(0);
    expect(imageParts(requests[1]!.messages)).toEqual([{ type: "image", attachment: screenshot, detail: "high" }]);
    const imageMessage = requests[1]!.messages.find(message => message.content.some(part => part.type === "image"));
    expect(imageMessage?.role).toBe("user");
    expect(imageMessage?.content[0]).toMatchObject({ type: "text", trust: "untrusted_tool" });
    const toolMessage = requests[1]!.messages.find(message => message.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain('"width":800');
    expect(JSON.stringify(toolMessage)).not.toContain("encryptedPath");
    expect(JSON.stringify(requests)).not.toContain("base64");
    expect(result.transcript.every(message => ModelMessageSchema.safeParse(message).success)).toBe(true);
  });

  it("keeps every result in a parallel tool batch before adding the image message", async () => {
    const { options, requests } = fixture({ parallelBatch: true });
    await runWithPiAgent(options);
    const second = requests[1]!.messages;
    const callIndex = second.findIndex(message => message.role === "assistant");
    expect(second.slice(callIndex, callIndex + 4).map(message => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(second[callIndex]!.content.filter(part => part.type === "tool_call").map(part => part.toolCallId)).toEqual(["shot-call", "read-call"]);
    expect(imageParts(second)).toHaveLength(1);
  });

  it("retains screenshot pixels for later model turns without repeatedly appending image messages", async () => {
    const { options, requests } = fixture({ laterRead: true });
    const result = await runWithPiAgent(options);
    expect(requests).toHaveLength(3);
    expect(requests.map(request => imageParts(request.messages).length)).toEqual([0, 1, 1]);
    expect(imageParts(result.transcript)).toHaveLength(1);
  });

  it("preserves encrypted image refs after transcript recovery without duplicating initial images", async () => {
    const initial = fixture({ initialImage: true });
    const result = await runWithPiAgent(initial.options);
    const restored = fixture({ initialImage: true, restored: result.transcript });
    const recovery = await runWithPiAgent(restored.options);
    expect(recovery.errorMessage).toBeUndefined();
    expect(imageParts(restored.requests[0]!.messages).map(part => part.attachment.id)).toEqual(["user-image", "browser-shot"]);
    expect(imageParts(recovery.transcript).map(part => part.attachment.id)).toEqual(["user-image", "browser-shot"]);
    expect(JSON.stringify(recovery.transcript)).not.toContain("base64");
  });

  it("retains the screenshot receipt while explicitly degrading a model without vision", async () => {
    const { options, requests } = fixture({ vision: false });
    const result = await runWithPiAgent(options);
    expect(imageParts(requests[1]!.messages)).toHaveLength(0);
    expect(JSON.stringify(requests[1]!.messages)).toContain("does not support vision");
    expect(JSON.stringify(requests[1]!.messages)).toContain("do not claim a visual assessment");
    expect(imageParts(result.transcript)).toHaveLength(1);
  });

  it("does not disclose a recovered browser screenshot to another provider", async () => {
    const initial = fixture();
    const original = await runWithPiAgent(initial.options);
    const recovered = fixture({ restored: original.transcript, providerId: "other-provider" });
    const result = await runWithPiAgent(recovered.options);
    expect(imageParts(recovered.requests[0]!.messages)).toHaveLength(0);
    expect(JSON.stringify(recovered.requests[0]!.messages)).toContain("other-provider is not authorized to receive its pixels");
    expect(imageParts(result.transcript)).toEqual([{ type: "image", attachment: screenshot, detail: "high" }]);
  });

  it("treats an empty browser screenshot provider list as no authorization", async () => {
    const initial = fixture();
    const original = await runWithPiAgent(initial.options);
    const transcript = original.transcript.map(message => ({ ...message, content: message.content.map(part => part.type === "image"
      ? { ...part, attachment: { ...part.attachment, allowedProviders: [] } } : part) }));
    const recovered = fixture({ restored: transcript });
    const result = await runWithPiAgent(recovered.options);
    expect(imageParts(recovered.requests[0]!.messages)).toHaveLength(0);
    expect(JSON.stringify(recovered.requests[0]!.messages)).toContain("fixture is not authorized to receive its pixels");
    expect(imageParts(result.transcript)[0]?.attachment.allowedProviders).toEqual([]);
  });

  it("keeps existing user file image behavior while blocking browser screenshots for another provider", async () => {
    const initial = fixture({ initialImage: true });
    const original = await runWithPiAgent(initial.options);
    const recovered = fixture({ restored: original.transcript, initialImage: true, providerId: "other-provider" });
    await runWithPiAgent(recovered.options);
    expect(imageParts(recovered.requests[0]!.messages).map(part => part.attachment.id)).toEqual(["user-image"]);
  });

  it.each(["responses", "chat_completions", "anthropic", "gemini"] as const)("submits a real screenshot image in the %s provider wire format", async protocol => {
    const { options, requests } = fixture();
    await runWithPiAgent(options);
    let body: Record<string, any> = {};
    let resolved = 0;
    const config = {
      id: "fixture", apiKey: "fixture", baseUrl: "https://fixture.test/v1", models: [options.model],
      resolveAttachment: async (attachment: AttachmentRef) => {
        expect(attachment).toEqual(screenshot); resolved++;
        return { mimeType: attachment.mimeType, base64: pngBase64 };
      },
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(protocol === "responses" ? 'data: {"type":"response.completed","response":{"id":"response"}}\n\n' : "data: [DONE]\n\n");
      },
    };
    const provider = protocol === "responses" ? new OpenAIProvider(config)
      : protocol === "chat_completions" ? new OpenAICompatibleProvider({ ...config, apiProtocol: "chat_completions" })
      : protocol === "anthropic" ? new AnthropicProvider(config) : new GeminiProvider(config);
    for await (const _event of provider.stream(requests[1]!, new AbortController().signal)) { /* drain the protocol adapter */ }
    expect(resolved).toBe(1);
    const dataUrl = `data:image/png;base64,${pngBase64}`;
    if (protocol === "responses") {
      expect(body.input.find((message: any) => message.role === "user" && message.content?.some((part: any) => part.type === "input_image"))?.content)
        .toContainEqual({ type: "input_image", image_url: dataUrl, detail: "high" });
      expect(body.input.find((message: any) => message.type === "function_call_output").output).not.toContain(pngBase64);
    } else if (protocol === "chat_completions") {
      expect(body.messages.find((message: any) => message.role === "user" && message.content?.some((part: any) => part.type === "image_url"))?.content)
        .toContainEqual({ type: "image_url", image_url: { url: dataUrl, detail: "high" } });
      expect(body.messages.find((message: any) => message.role === "tool").content).not.toContain(pngBase64);
    } else if (protocol === "anthropic") {
      expect(body.messages.flatMap((message: any) => message.content)).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } });
    } else expect(body.contents.flatMap((message: any) => message.parts)).toContainEqual({ inlineData: { mimeType: "image/png", data: pngBase64 } });
  });
});
