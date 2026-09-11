import { describe, it, expect } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

describe("1.4 compacted model history", () => {
  it("rejects DSML summaries and checkpoints the compacted context instead of original history", async () => {
    const model = descriptor({ providerId: "fake", modelId: "compact", displayName: "Compact", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 4096, dataPolicy: "local" } });
    const requests: ModelRequest[] = [], saved: ModelMessage[][] = [];
    const provider: ModelProvider = { id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; }, async *stream(request) {
      requests.push(request);
      yield { type: "text_delta" as const, delta: request.purpose === "compaction" ? "<DSML><invoke name='terminal'>bad</invoke></DSML>" : "Analysis complete; evidence retained." };
    } };
    const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect memory; do not change source.", trust: "user_request" }] }];
    for (let i = 0; i < 40; i++) history.push({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `old-record-${i} ${"old information ".repeat(100)}` }] });
    history.push({ role: "user", content: [{ type: "text", trust: "user_request", text: "Continue with retained evidence" }] });
    let fallback = false;
    let compactedSummary = "";
    const result = await runWithPiAgent({ runId: "r", sessionId: "s", model, provider, initialMessages: [{ role: "system", content: [{ type: "text", trust: "app_policy", text: "FIXED SAFETY" }] }], resumeTranscript: history, contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 200, parallelToolCalls: false, contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 }, getPinnedContext: () => JSON.stringify({ objective: "Inspect memory", evidence: { read1: "memory.ts" }, intent: "analysis", decisions: ["preserve public API"], todos: [{ id: "done", text: "inspect callers", status: "completed" }, { id: "pending", text: "check cancellation", status: "pending" }] }), beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onTranscript: async messages => { saved.push(messages); }, onCompaction: async event => { fallback = event.deterministicFallback; compactedSummary = event.summary; } });
    expect(requests.find(r => r.purpose === "compaction")?.maxOutputTokens).toBe(2048);
    expect(fallback).toBe(true);
    expect(JSON.parse(compactedSummary)).toMatchObject({ decisions: expect.arrayContaining(["preserve public API"]), completed: [expect.objectContaining({id:"done"})], pending: [expect.objectContaining({id:"pending"})] });
    const main = requests.findLast(request => request.purpose === "main")!;
    expect(Math.ceil(JSON.stringify({ messages: main.messages, tools: main.tools }).length / 4)).toBeLessThanOrEqual(Math.floor((4096 - 200) * .45));
    expect(JSON.stringify(result.transcript)).not.toContain("<DSML>");
    expect(JSON.stringify(result.transcript).length).toBeLessThan(JSON.stringify(history).length / 2);
    expect(JSON.stringify(saved.at(-1)).length).toBeLessThan(JSON.stringify(history).length / 2);
    expect(JSON.stringify(result.transcript)).toContain("Inspect memory");
  });
});
