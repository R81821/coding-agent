import { describe, it, expect } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

describe("1.4 compacted model history", () => {
  it("rejects DSML summaries and retains the original history without committing compaction", async () => {
    const model = descriptor({ providerId: "fake", modelId: "compact", displayName: "Compact", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 4096, dataPolicy: "local" } });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = { id: "fake", supportsNonThinkingCompaction: () => true, async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; }, async *stream(request) {
      requests.push(request);
      yield { type: "text_delta" as const, delta: request.purpose === "compaction" ? "<DSML><invoke name='terminal'>bad</invoke></DSML>" : "Analysis complete; evidence retained." };
    } };
    const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect memory; do not change source.", trust: "user_request" }] }];
    for (let i = 0; i < 40; i++) history.push({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `old-record-${i} ${"old information ".repeat(100)}` }] });
    history.push({ role: "user", content: [{ type: "text", trust: "user_request", text: "Continue with retained evidence" }] });
    let compactions = 0;
    const result = await runWithPiAgent({ runId: "r", sessionId: "s", model, provider, initialMessages: [{ role: "system", content: [{ type: "text", trust: "app_policy", text: "FIXED SAFETY" }] }], resumeTranscript: history, contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 200, parallelToolCalls: false, contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 }, getPinnedContext: () => JSON.stringify({ objective: "Inspect memory", evidence: { read1: "memory.ts" }, intent: "analysis", decisions: ["preserve public API"], todos: [{ id: "done", text: "inspect callers", status: "completed" }, { id: "pending", text: "check cancellation", status: "pending" }] }), beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onCompaction: async () => { compactions += 1; } });
    expect(result.errorMessage).toBeDefined();
    expect(compactions).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.purpose).toBe("compaction");
    for (const request of requests.filter(request => request.purpose === "compaction")) {
      expect(request.maxOutputTokens).toBeGreaterThan(0);
      expect(request.maxOutputTokens).toBeLessThan(4096);
    }
    expect(JSON.stringify(result.transcript)).not.toContain("<DSML>");
    for (const message of history) {
      for (const part of message.content) if (part.type === "text") expect(JSON.stringify(result.transcript)).toContain(part.text);
    }
    expect(JSON.stringify(result.transcript)).toContain("preserve public API");
  });
});
