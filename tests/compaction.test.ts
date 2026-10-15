import { describe, expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

describe("pi transformContext compaction", () => {
  it("compacts historical observations while preserving the current request and pinned context", async () => {
    const model = descriptor({ providerId: "fake", modelId: "compact", displayName: "Compact", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 4_096, dataPolicy: "local" } });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        yield { type: "text_delta", delta: request.purpose === "compaction" ? JSON.stringify({
          goal: "Continue the original inspection.", constraints: ["Preserve the request and approved permissions."],
          decisions: [], evidence: [], completed: ["Earlier turns inspected files; no side effects occurred."], pending: ["Continue safely."],
        }) : "resumed" };
      }
    };
    const transcript: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "ORIGINAL CURRENT REQUEST", trust: "user_request" }] }];
    // Historical observations are untrusted data; actual user requirements are retained verbatim.
    for (let index = 0; index < 24; index += 1) transcript.push({ role: index % 2 ? "user" : "assistant", content: [{ type: "text", text: `${index}:${"history ".repeat(40)}`, trust: "untrusted_tool" }] });
    transcript.push({ role: "user", content: [{ type: "text", text: "continue safely", trust: "user_request" }] });
    let compacted = false;
    const result = await runWithPiAgent({ runId: "run", sessionId: "session", provider, model, initialMessages: [{ role: "system", content: [{ type: "text", text: "SAFETY POLICY", trust: "app_policy" }] }, { role: "user", content: [{ type: "text", text: "ORIGINAL CURRENT REQUEST", trust: "user_request" }] }], contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 200, parallelToolCalls: false, resumeTranscript: transcript, contextPolicy: { compactAtRatio: 0.7, maxAfterCompactionRatio: 0.45, retainRecentTurns: 2 }, getPinnedContext: () => "APPROVED PLAN + PERMISSIONS", beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onCompaction: async ({ after }) => { compacted = true; expect(JSON.stringify(after)).toContain("ORIGINAL CURRENT REQUEST"); expect(JSON.stringify(after)).toContain("APPROVED PLAN + PERMISSIONS"); } });
    expect(result.errorMessage).toBeUndefined();
    expect(compacted).toBe(true);
    const finalRequest = requests.at(-1)!;
    expect(finalRequest.purpose).toBe("main");
    expect(requests.some(request => request.purpose === "compaction")).toBe(true);
    expect(Math.ceil(JSON.stringify({ messages: finalRequest.messages, tools: finalRequest.tools }).length / 2)).toBeLessThanOrEqual(Math.floor(model.capabilities.maxContextTokens * .45));
  });

  it("retains original history when a tiny model cannot fit the required summary prompt", async () => {
    const model = descriptor({ providerId: "fake", modelId: "tiny", displayName: "Tiny", maxContextTokens: 1_000 });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) { requests.push(request); yield { type: "text_delta" as const, delta: "Unexpected dispatch." }; },
    };
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", trust: "user_request", text: "Preserve the API and investigate the race." }] },
      { role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: "IMPORTANT_FAILURE_AND_FIX: " + "investigation ".repeat(300) }] },
    ];
    let compactions = 0;
    const result = await runWithPiAgent({ runId: "tiny", sessionId: "tiny", provider, model,
      initialMessages: [history[0]!], resumeTranscript: history, contracts: [], resolveTool: () => undefined,
      externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: false,
      contextPolicy: { compactAtRatio: .7, maxAfterCompactionRatio: .45, retainRecentTurns: 1 },
      beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false,
      onProviderEvent: () => {}, onCompaction: () => { compactions += 1; },
    });
    expect(result.errorMessage).toContain("context_budget_exceeded");
    expect(requests).toEqual([]);
    expect(compactions).toBe(0);
    for (const message of history) {
      for (const part of message.content) if (part.type === "text") expect(JSON.stringify(result.transcript)).toContain(part.text);
    }
  });
});
