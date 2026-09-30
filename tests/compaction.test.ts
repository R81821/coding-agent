import { describe, expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

describe("pi transformContext compaction", () => {
  it("compacts above 70%, retains the current request, and stays below 80%", async () => {
    const model = descriptor({ providerId: "fake", modelId: "compact", displayName: "Compact", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 1_000, dataPolicy: "local" } });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        const summarizing = request.messages.some((message) => message.content.some((part) => part.type === "text" && part.text.includes("Summarize the supplied")));
        yield { type: "text_delta", delta: summarizing ? "Earlier turns inspected files; no side effects occurred." : "resumed" };
      }
    };
    const transcript: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "ORIGINAL CURRENT REQUEST", trust: "user_request" }] }];
    // Historical observations are untrusted data; actual user requirements are retained verbatim.
    for (let index = 0; index < 24; index += 1) transcript.push({ role: index % 2 ? "user" : "assistant", content: [{ type: "text", text: `${index}:${"history ".repeat(40)}`, trust: "untrusted_tool" }] });
    transcript.push({ role: "user", content: [{ type: "text", text: "continue safely", trust: "user_request" }] });
    let compacted = false;
    await runWithPiAgent({ runId: "run", sessionId: "session", provider, model, initialMessages: [{ role: "system", content: [{ type: "text", text: "SAFETY POLICY", trust: "app_policy" }] }, { role: "user", content: [{ type: "text", text: "ORIGINAL CURRENT REQUEST", trust: "user_request" }] }], contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 200, parallelToolCalls: false, resumeTranscript: transcript, contextPolicy: { compactAtRatio: 0.7, maxAfterCompactionRatio: 0.8, retainRecentTurns: 2 }, getPinnedContext: () => "APPROVED PLAN + PERMISSIONS", beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onCompaction: async ({ after }) => { compacted = true; expect(JSON.stringify(after)).toContain("ORIGINAL CURRENT REQUEST"); expect(JSON.stringify(after)).toContain("APPROVED PLAN + PERMISSIONS"); } });
    expect(compacted).toBe(true);
    const finalRequest = requests.at(-1)!;
    expect(Math.ceil(JSON.stringify(finalRequest.messages).length / 4)).toBeLessThanOrEqual(800);
  });
});
