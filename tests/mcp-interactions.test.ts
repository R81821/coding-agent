import { describe, expect, it } from "vitest";
import { McpInteractionBroker, redactMcpValue } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import { latestContextUsage, type ModelRequest } from "@harness/protocol";
import { mcpSamplingMessages, sampleMcp } from "../packages/core/src/mcp-sampling.js";

const source = { serverId: "source", serverName: "Source", workspacePath: "D:/fixture" };
const params = { messages: [{ role: "user" as const, content: { type: "text" as const, text: "Summarize this server data" } }], maxTokens: 400 };
const form = { message: "Select a topic", requestedSchema: { type: "object", properties: {
  topic: { type: "string", enum: ["code", "docs"] }, count: { type: "integer", minimum: 1, maximum: 4 }, ready: { type: "boolean" },
}, required: ["topic", "count"] } };

describe("MCP interaction decisions", () => {
  it("validates form data without consuming the pending request on invalid input", async () => {
    const broker = new McpInteractionBroker();
    const pending = broker.request("elicitation", source, form, new AbortController().signal, { runId: "run" });
    const id = broker.list(source.workspacePath)[0]!.id;
    for (const content of [{ topic: "wrong", count: 1 }, { topic: "docs", count: 1.5 }, { topic: "docs" }, { topic: "docs", count: 1, extra: "hidden" }]) {
      expect(() => broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "accept", content })).toThrow();
      expect(broker.list(source.workspacePath)).toHaveLength(1);
    }
    broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "accept", content: { topic: "docs", count: 2, ready: false } });
    expect(await pending).toMatchObject({ action: "accept", content: { topic: "docs", count: 2, ready: false } });
    expect(broker.list(source.workspacePath)).toEqual([]);
    expect(() => broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "accept" })).toThrow(/no longer pending/);
  });

  it("does not let a different project list or approve the request", async () => {
    const broker = new McpInteractionBroker();
    const pending = broker.request("sampling", source, params, new AbortController().signal, { runId: "run", modelName: "Actual model" });
    const id = broker.list(source.workspacePath, "run")[0]!.id;
    expect(broker.list("D:/other")).toEqual([]);
    expect(broker.list(source.workspacePath, "other-run")).toEqual([]);
    expect(() => broker.respond({ requestId: id, workspacePath: "D:/other", action: "accept" })).toThrow();
    expect(() => broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "accept", content: { replace: "task" } })).toThrow();
    broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "decline" });
    expect(await pending).toMatchObject({ action: "decline" });
  });

  it("cancels only the paused run and removes requests on connection cancellation", async () => {
    const broker = new McpInteractionBroker();
    const signal = new AbortController();
    const paused = broker.request("sampling", source, params, signal.signal, { runId: "paused" });
    const other = broker.request("elicitation", source, form, signal.signal, { runId: "other" });
    const rejected = expect(paused).rejects.toThrow(/pause/);
    broker.cancelRun("paused"); await rejected;
    expect(broker.list(source.workspacePath).map(request => request.runId)).toEqual(["other"]);
    const cancelled = expect(other).rejects.toThrow(/cancelled/);
    signal.abort(); await cancelled;
    expect(broker.list(source.workspacePath)).toEqual([]);
  });

  it("accepts URL confirmation without form content and supports user cancellation", async () => {
    const broker = new McpInteractionBroker();
    const pending = broker.request("elicitation", source, { mode: "url", message: "Authorize", url: "https://example.test/auth", elicitationId: "auth" }, new AbortController().signal);
    const id = broker.list(source.workspacePath)[0]!.id;
    expect(() => broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "accept", content: { password: "unexpected" } })).toThrow();
    broker.respond({ requestId: id, workspacePath: source.workspacePath, action: "cancel" });
    expect(await pending).toMatchObject({ action: "cancel" });
  });

  it("redacts credentials without corrupting binary image data", () => {
    expect(redactMcpValue({ content: [{ type: "text", text: "token abc" }, { type: "image", data: "abc", mimeType: "image/png" }], structuredContent: { secret: "abc" } }, ["abc"]))
      .toEqual({ content: [{ type: "text", text: "token [redacted]" }, { type: "image", data: "abc", mimeType: "image/png" }], structuredContent: { secret: "[redacted]" } });
    expect(redactMcpValue({ contents: [{ uri: "fixture://binary", blob: "abc" }],
      messages: [{ role: "user", content: { type: "resource", resource: { uri: "fixture://binary", blob: "abc" } } }],
      structuredContent: { blob: "abc", type: "image", data: "abc" },
      _meta: { content: { type: "image", data: "abc" }, resource: { blob: "abc" } },
      requestedSchema: { type: "object", properties: { blob: { type: "string", default: "abc" } } },
    }, ["abc"]))
      .toEqual({ contents: [{ uri: "fixture://binary", blob: "abc" }],
        messages: [{ role: "user", content: { type: "resource", resource: { uri: "fixture://binary", blob: "abc" } } }],
        structuredContent: { blob: "[redacted]", type: "image", data: "[redacted]" },
        _meta: { content: { type: "image", data: "[redacted]" }, resource: { blob: "[redacted]" } },
        requestedSchema: { type: "object", properties: { blob: { type: "string", default: "[redacted]" } } },
      });
  });
});

describe("MCP sampling generation", () => {
  it("uses only supplied messages, actual output capacity, and separately billed sampling usage", async () => {
    const model = descriptor({ providerId: "fixture", modelId: "sample", displayName: "Sample", capabilities: {
      vision: true, tools: true, parallelTools: false, structuredOutput: false, maxContextTokens: 1_000_000, maxOutputTokens: 200, dataPolicy: "local",
    } });
    let captured: ModelRequest | undefined, requests = 0;
    const usage: unknown[] = [], timings: unknown[] = [];
    const provider: ModelProvider = { id: "fixture", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream(request) { captured = request; yield { type: "text_delta", delta: "Server response" }; yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0 } }; } };
    const messages = await mcpSamplingMessages({ ...params, systemPrompt: "Server instruction", includeContext: "allServers" });
    const result = await sampleMcp({ params, messages, provider, model, runId: "run", signal: new AbortController().signal,
      beforeRequest: () => { requests++; }, onUsage: value => { usage.push(value); }, onFinished: value => { timings.push(value); } });
    expect(result).toMatchObject({ role: "assistant", content: { type: "text", text: "Server response" }, model: "sample" });
    expect(captured).toMatchObject({ maxOutputTokens: 200, tools: [], purpose: "sampling", store: false });
    expect(JSON.stringify(messages)).toContain("Server instruction");
    expect(messages[1]!.role).toBe("user");
    expect(requests).toBe(1);
    expect(usage).toEqual([{ inputTokens: 100, outputTokens: 20, estimatedUsd: 0, purpose: "sampling" }]);
    expect(timings).toEqual([expect.objectContaining({ purpose: "sampling", succeeded: true })]);
    expect(latestContextUsage([{ type: "usage", usage: usage[0] } as never])).toBeUndefined();
  });

  it("refuses unavailable tools, invalid output limits and unsupported audio before generation", async () => {
    await expect(mcpSamplingMessages({ ...params, maxTokens: 0 })).rejects.toThrow(/positive/);
    await expect(mcpSamplingMessages({ ...params, tools: [{ name: "run_command", inputSchema: { type: "object" } }] })).rejects.toThrow(/tool execution/);
    await expect(mcpSamplingMessages({ ...params, messages: [{ role: "user", content: { type: "audio", data: "AA==", mimeType: "audio/wav" } }] })).rejects.toThrow(/audio/);
  });
});
