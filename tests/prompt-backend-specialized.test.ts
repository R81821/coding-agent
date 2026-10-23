import { describe, expect, it, vi } from "vitest";
import type { MemoryService } from "@harness/extensions";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";
import { summarizeContext } from "../packages/core/src/context-summary.js";
import { estimateRequestInputTokens, resolveRequestOutputTokens } from "../packages/core/src/generation-policy.js";
import { learnFromRun } from "../packages/core/src/memory-learning.js";
import { mcpSamplingMessages, sampleMcp } from "../packages/core/src/mcp-sampling.js";
import { preparePromptRequest } from "../packages/core/src/prompt-system.js";

const identity = "You are an AI agent powered by DeepSeek Harness.";
const textOf = (messages: ModelMessage[]) => messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");
const systemText = (request: ModelRequest) => textOf(request.messages.filter(message => message.role === "system" || message.role === "developer"));

function fixture(output = "Separate response", capacity = 8192) {
  const model = descriptor({ providerId: "specialized", modelId: "specialized-model", displayName: "Specialized", maxContextTokens: capacity, maxOutputTokens: 256 });
  const requests: ModelRequest[] = [];
  const estimateCost = vi.fn(() => 0);
  const provider: ModelProvider = {
    id: model.providerId, promptBackend: "dsh", listModels: async () => [model], health: async () => true, estimateCost,
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "text_delta", delta: output };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: 0 } };
    },
  };
  return { model, provider, requests, estimateCost };
}

function expectSpecialized(request: ModelRequest, purpose: "compaction" | "memory" | "sampling", instruction: string) {
  expect(request).toMatchObject({ purpose, tools: [], store: false, parallelToolCalls: false });
  expect(systemText(request)).toContain(instruction);
  expect(systemText(request).split(identity)).toHaveLength(2);
  expect(systemText(request)).not.toContain("Understand the outcome the user wants before choosing tools");
  expect(request.maxOutputTokens).toBeLessThanOrEqual(256);
}

describe("dsh specialized generations", () => {
  it.each(["compaction", "memory", "sampling"] as const)("preserves the %s contract and untrusted text without mutating the source request", async purpose => {
    const { model, provider } = fixture();
    const request: ModelRequest = {
      purpose, model, runId: "specialized", tools: [], maxOutputTokens: 100, parallelToolCalls: false, store: false,
      messages: [
        { role: "system", content: [{ type: "text", trust: "app_policy", text: "SPECIALIZED_CONTRACT: return only approved JSON." }] },
        { role: "user", content: [{ type: "text", trust: "untrusted_tool", text: "Untrusted literal {{model}} and {{unknown}}." }] },
      ],
    };
    const before = structuredClone(request);
    const prepared = await preparePromptRequest(provider, request);
    expectSpecialized(prepared, purpose, "SPECIALIZED_CONTRACT");
    expect(request).toEqual(before);
    expect(prepared.messages.find(message => message.role === "user")).toEqual(before.messages[1]);
  });

  it("dispatches isolated MCP messages with the server guidance still untrusted", async () => {
    const { model, provider, requests } = fixture();
    const params = { maxTokens: 400, systemPrompt: "SERVER_GUIDANCE {{model}}", messages: [{ role: "user" as const, content: { type: "text" as const, text: "Only this approved server input" } }] };
    const messages = await mcpSamplingMessages(params);
    const onUsage = vi.fn(), beforeRequest = vi.fn();
    const result = await sampleMcp({ params, messages, provider, model, runId: "sample", signal: new AbortController().signal,
      beforeRequest, onUsage, onFinished: vi.fn() });
    expect(result.content).toEqual({ type: "text", text: "Separate response" });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expectSpecialized(request, "sampling", "no host tools or private conversation history");
    expect(systemText(request)).not.toContain("SERVER_GUIDANCE");
    expect(request.messages.find(message => textOf([message]).includes("SERVER_GUIDANCE"))).toMatchObject({
      role: "user", content: [{ type: "text", trust: "untrusted_tool", text: "MCP server supplied guidance:\nSERVER_GUIDANCE {{model}}" }],
    });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "sampling" }));
  });

  it("retains the cumulative JSON summary rules when dispatching compaction", async () => {
    const summary = { goal: "Continue the task", constraints: ["Preserve permissions"], decisions: [], evidence: [], completed: [], pending: ["Inspect result"] };
    const { model, provider, requests } = fixture(JSON.stringify(summary));
    const result = await summarizeContext({ model, provider, runId: "summary", messages: [], task: ["Continue the task"], state: JSON.stringify(summary),
      merge: (_previous, generated) => generated, signal: new AbortController().signal, onProviderEvent: vi.fn() });
    expect(JSON.parse(result)).toEqual(summary);
    expect(requests).toHaveLength(1);
    expectSpecialized(requests[0]!, "compaction", "Return only a JSON object with exactly goal, constraints, decisions, evidence, completed, and pending");
    expect(systemText(requests[0]!)).not.toContain("MCP server");
  });

  it("includes the assembled memory instructions in the cost decision before dispatch", async () => {
    const { model, provider, requests, estimateCost } = fixture('{"memories":[]}');
    const memory = { list: () => [], propose: vi.fn() } as unknown as MemoryService;
    const beforeRequest = vi.fn(), onUsage = vi.fn();
    const result = await learnFromRun({ model, provider, memory, runId: "memory", workspacePath: "D:/fixture", userMessages: ["Only this user source"],
      outcome: "No change", verified: false, scopes: ["project"], signal: new AbortController().signal, remainingUsd: 1,
      beforeRequest, onUsage, onFinished: vi.fn() });
    expect(result).toEqual([]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expectSpecialized(request, "memory", "Extract only durable, useful knowledge");
    expect(estimateCost).toHaveBeenCalledWith(model, estimateRequestInputTokens(request), request.maxOutputTokens);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "memory" }));
    expect(memory.propose).not.toHaveBeenCalled();
  });

  it("refuses sampling before provider dispatch when the assembled identity exhausts context", async () => {
    const params = { maxTokens: 1, messages: [{ role: "user" as const, content: { type: "text" as const, text: "Approved input" } }] };
    const messages = await mcpSamplingMessages(params);
    const bareInput = estimateRequestInputTokens({ messages, tools: [] });
    let capacity = bareInput + 1;
    while (capacity !== bareInput + 1 + Math.min(1024, Math.floor(capacity / 16))) capacity = bareInput + 1 + Math.min(1024, Math.floor(capacity / 16));
    const { model, provider, requests } = fixture("unused", capacity);
    expect(resolveRequestOutputTokens({ model, maxOutputTokens: 1, estimatedInputTokens: bareInput })).toBe(1);
    const beforeRequest = vi.fn();
    await expect(sampleMcp({ params, messages, model, provider, runId: "too-small", signal: new AbortController().signal,
      beforeRequest, onUsage: vi.fn(), onFinished: vi.fn() })).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
