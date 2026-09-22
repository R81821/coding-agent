import { describe, expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";

describe("output ceiling and usable task context", () => {
  it.each([
    { context: 128_000, ceiling: 393_216, policy: true },
    { context: 128_000, ceiling: 393_216, policy: false },
    { context: 1_000_000, ceiling: 393_216, policy: true },
    { context: 128_000, ceiling: 512, policy: true },
  ])("runs skill-guided tools with $context context and $ceiling output ceiling (policy=$policy)", async ({ context, ceiling, policy }) => {
    const requests: ModelRequest[] = [];
    const model = descriptor({ providerId: "fixture", modelId: "budget", displayName: "budget", maxContextTokens: context });
    const provider: ModelProvider = {
      id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) {
        requests.push(structuredClone(request));
        if (request.purpose === "compaction") throw new Error("A short task must not compact before its first main request");
        if (requests.length === 1) yield { type: "tool_call" as const, toolCall: { id: "read", name: "read_file", input: { path: "example.txt" } } };
        else yield { type: "text_delta" as const, delta: "verified tool result" };
      },
    };
    const result = await runWithPiAgent({
      runId: "budget-run", sessionId: "budget-session", model, provider,
      initialMessages: [
        { role: "system", content: [{ type: "text", trust: "app_policy", text: "Follow the selected skill and use declared tools." }] },
        { role: "user", content: [{ type: "text", trust: "trusted_project", text: "PROJECT_SKILL_MARKER: read example.txt before answering." }] },
        { role: "user", content: [{ type: "text", trust: "user_request", text: "Inspect the example." }] },
      ],
      contracts: [workflowReadTool.contract], resolveTool: () => workflowReadTool,
      externalSignal: new AbortController().signal, maxOutputTokens: ceiling, parallelToolCalls: false,
      ...(policy ? { contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 2 } } : {}),
      beforeToolCall: async () => ({}), executeTool: async () => ({ output: "TOOL_RESULT_MARKER " + "x".repeat(8000) }),
      shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    });
    expect(result.errorMessage).toBeUndefined();
    expect(requests.map(request => request.purpose)).toEqual(["main", "main"]);
    expect(JSON.stringify(requests[0]!.messages)).toContain("PROJECT_SKILL_MARKER");
    expect(JSON.stringify(requests[1]!.messages)).toContain("TOOL_RESULT_MARKER");
    for (const request of requests) {
      expect(request.maxOutputTokens).toBeGreaterThan(0);
      expect(request.maxOutputTokens).toBeLessThanOrEqual(ceiling);
      const inputEstimate = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4);
      expect(request.maxOutputTokens + inputEstimate).toBeLessThan(context);
    }
    if (context > ceiling || ceiling === 512) {
      expect(requests.map(request => request.maxOutputTokens)).toEqual([ceiling, ceiling]);
    } else {
      expect(requests[0]!.maxOutputTokens).toBeGreaterThan(8192);
      expect(requests[1]!.maxOutputTokens).toBeLessThan(requests[0]!.maxOutputTokens);
    }
  });
});

it("allows a short request on a 1024-token model", async () => {
  const { result, requests } = await budgetFixture(1024, 128, [
    { role: "user", content: [{ type: "text", trust: "user_request", text: "Hi" }] },
  ], () => 16);
  expect(result.errorMessage).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.maxOutputTokens).toBe(128);
});

it("uses measured provider input usage when a subsequent tool result makes the output limit binding", async () => {
  const { result, requests } = await budgetFixture(480_000, 393_216, [
    { role: "user", content: [{ type: "text", trust: "user_request", text: "a".repeat(10000) }] },
  ], (_request, turn) => turn === 1 ? 20_000 : 100_000, true);
  expect(result.errorMessage).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.maxOutputTokens).toBe(393_216);
  expect(requests[1]!.maxOutputTokens).toBeLessThanOrEqual(380_000);
});

it.each([false, true])("reserves input space for initial Chinese text and images (image=%s)", async image => {
  const content: ModelMessage["content"] = [{ type: "text", trust: "user_request", text: "查看项目任务和工具".repeat(500) }];
  if (image) content.push({ type: "image", detail: "auto", attachment: { id: "image", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 1000, encryptedPath: "fixture", source: "file", trust: "untrusted_attachment", allowedProviders: ["fixture"], createdAt: new Date().toISOString() } });
  const { result, requests } = await budgetFixture(128_000, 393_216, [{ role: "user", content }], () => image ? 18_000 : 8_000);
  expect(result.errorMessage).toBeUndefined();
  expect(requests).toHaveLength(1);
});

async function budgetFixture(context: number, ceiling: number, messages: ModelMessage[], inputTokens: (request: ModelRequest, turn: number) => number, toolTurn = false) {
  const requests: ModelRequest[] = [];
  const model = descriptor({ providerId: "fixture", modelId: "measured-budget", displayName: "measured-budget", maxContextTokens: context });
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      // The server's independently specified token counts deliberately disagree with chars/4.
      const measuredInput = inputTokens(request, requests.length);
      if (measuredInput + request.maxOutputTokens > context) throw new Error("server rejected combined input and output budget");
      if (toolTurn && requests.length === 1) yield { type: "tool_call" as const, toolCall: { id: "read", name: "read_file", input: { path: "example.txt" } } };
      else yield { type: "text_delta" as const, delta: "done" };
      yield { type: "usage" as const, usage: { inputTokens: measuredInput, outputTokens: 10, estimatedUsd: 0 } };
    },
  };
  const result = await runWithPiAgent({
    runId: "measured-budget", sessionId: "measured-budget", model, provider, initialMessages: messages,
    contracts: toolTurn ? [workflowReadTool.contract] : [], resolveTool: () => workflowReadTool,
    externalSignal: new AbortController().signal, maxOutputTokens: ceiling, parallelToolCalls: false,
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: "x".repeat(40_000) }),
    shouldStopAfterTurn: () => false, onProviderEvent: () => {},
  });
  return { result, requests };
}
