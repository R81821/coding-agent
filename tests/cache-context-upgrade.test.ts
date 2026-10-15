import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeResult } from "@harness/core";
import { descriptor, ProviderOutputTruncatedError, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { canonicalJson, type ModelRequest } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";

async function trajectory(summarySupported = false, outputSize = 6000, mode = "invalid_json", disableModelSummary = false) {
  const requests: ModelRequest[] = [], adjustments: any[] = [], compactions: any[] = [];
  const events: ProviderStreamEvent[] = [];
  let turns = 0;
  const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture", maxContextTokens: 16384 });
  const provider: ModelProvider = {
    id: "fixture", supportsNonThinkingCompaction: () => summarySupported,
    async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.purpose === "compaction") {
        yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, estimatedUsd: 0 } };
        if (mode === "truncated") throw new ProviderOutputTruncatedError("length");
        if (mode === "provider_error") throw new Error("fixture provider unavailable");
        yield { type: "text_delta" as const, delta: mode === "empty" ? "" : mode === "accepted" || mode === "invalid_items" ? JSON.stringify({ goal: "Inspect only", constraints: ["preserve requirement"], decisions: [], evidence: ["read-1"], completed: ["inspection"], pending: mode === "invalid_items" ? [null, false, { unknown: 1 }] : ["report"] }) : "not valid JSON" }; return;
      }
      turns++;
      // Long assistant reasoning forces real compaction even after old tool payloads are pruned.
      if (summarySupported) yield { type: "reasoning_delta" as const, delta: `ORIGINAL_REASONING_TURN_${turns}: ` + "reasoning ".repeat(600) };
      if (turns < 14) yield { type: "tool_call" as const, toolCall: { id: "read-" + turns, name: "read_file", input: { path: "example.ts" } } };
      else yield { type: "text_delta" as const, delta: "done" };
    }
  };
  const result = await runWithPiAgent({ runId: "cache-test", sessionId: "cache", model, provider,
    initialMessages: [{ role: "system", content: [{ type: "text", trust: "app_policy", text: "FIXED" }] }, { role: "user", content: [{ type: "text", trust: "user_request", text: "Inspect only, preserve this requirement." }] }],
    contracts: [workflowReadTool.contract, { ...workflowReadTool.contract, name: "read_evidence" }], resolveTool: () => workflowReadTool, externalSignal: new AbortController().signal,
    maxOutputTokens: 100, parallelToolCalls: false, disableModelSummary, contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 },
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: "x".repeat(outputSize) }), shouldStopAfterTurn: () => false,
    beforeCompactionRequest: () => mode !== "budget",
    onProviderEvent: event => { events.push(event); }, onContextAdjustment: value => { adjustments.push(value); }, onCompaction: value => { compactions.push(value); }
  });
  return { result, requests, adjustments, compactions, events };
}

function expectRetainedHistory(result: PiAgentBridgeResult, requests: ModelRequest[]) {
  const transcript = JSON.stringify(result.transcript);
  expect(transcript.includes("Inspect only, preserve this requirement.")).toBe(true);
  expect(transcript.includes("ORIGINAL_REASONING_TURN_1:")).toBe(true);
  expect(transcript.includes("Untrusted compacted history summary.")).toBe(false);
  const transcriptText = result.transcript.flatMap(message => message.content)
    .flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  const lastMain = requests.findLast(request => request.purpose === "main")!;
  for (const part of lastMain.messages.flatMap(message => message.content)) {
    if (part.type === "text") expect(transcriptText.includes(part.text)).toBe(true);
  }
  const firstTool = requests.flatMap(request => request.messages.flatMap(message => message.content))
    .find(part => part.type === "tool_result" && part.toolCallId === "read-1");
  expect(firstTool).toBeDefined();
  expect(result.transcript.flatMap(message => message.content)
    .find(part => part.type === "tool_result" && part.toolCallId === "read-1")).toEqual(firstTool);
}

describe("cache context upgrade", () => {
  it("retains original history and stops without a billable summary when the budget refuses it", async () => {
    const { result, requests, compactions, events } = await trajectory(true, 6000, "budget");
    expect(requests.some(request => request.purpose === "compaction")).toBe(false);
    expect(compactions).toEqual([]);
    expect(result.errorMessage).toContain("context_summary_budget_exhausted");
    expectRetainedHistory(result, requests);
    expect(events.filter(event => event.type === "usage")).toHaveLength(0);
  });
  it.each([
    { mode: "truncated", error: "截断" },
    { mode: "empty", error: "context_summary_empty" },
    { mode: "provider_error", error: "fixture provider unavailable" },
  ])("stops once for $mode and retains billable usage and original history", async ({ mode, error }) => {
    const { result, requests, compactions, events } = await trajectory(true, 6000, mode);
    expect(requests.filter(r => r.purpose === "compaction")).toHaveLength(1);
    expect(requests.at(-1)?.purpose).toBe("compaction");
    expect(compactions).toEqual([]);
    expect(result.errorMessage).toContain(error);
    expectRetainedHistory(result, requests);
    expect(events.filter(e => e.type === "usage")).toEqual([expect.objectContaining({ usage: expect.objectContaining({ purpose: "compaction", inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }) })]);
  });
  it("adopts valid summaries, keeps the original requirement and does not disable later summaries", async () => {
    const { result, requests, compactions } = await trajectory(true, 6000, "accepted");
    expect(result.errorMessage).toBeUndefined();
    expect(compactions.length).toBeGreaterThan(1);
    expect(compactions.every(c => c.summaryOutcome === "accepted" && !c.deterministicFallback)).toBe(true);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Inspect only, preserve this requirement.");
    expect(JSON.parse(compactions[0].summary)).toMatchObject({ evidence: expect.arrayContaining(["read-1", expect.objectContaining({ id: "read-1" })]), pending: ["report"] });
  });
  it("rejects unsupported array item shapes even in parseable summary JSON", async () => {
    const { result, requests, compactions } = await trajectory(true, 6000, "invalid_items");
    expect(requests.filter(r => r.purpose === "compaction")).toHaveLength(1);
    expect(requests.at(-1)?.purpose).toBe("compaction");
    expect(compactions).toEqual([]);
    expect(result.errorMessage).toContain("context_summary_invalid_json");
    expectRetainedHistory(result, requests);
  });
  it("stops safely without a billable request when model summarization was disabled on recovery", async () => {
    const { result, requests, compactions, events } = await trajectory(true, 6000, "accepted", true);
    expect(requests.filter(r => r.purpose === "compaction")).toHaveLength(0);
    expect(compactions).toEqual([]);
    expect(result.errorMessage).toContain("context_summary_unavailable");
    expectRetainedHistory(result, requests);
    expect(events.filter(event => event.type === "usage")).toEqual([]);
  });
  it("accounts for every historical prefix rewrite", async () => {
    const { result, requests, adjustments } = await trajectory(false, 6000, "accepted");
    expect(result.errorMessage).toBeUndefined();
    const main = requests.filter(r => r.purpose === "main");
    const rewrites = main.slice(1).filter((next,i) => canonicalJson(next.messages.slice(0, main[i]!.messages.length)) !== canonicalJson(main[i]!.messages));
    expect(rewrites.length).toBeGreaterThan(0);
    const rebuilds = adjustments.filter(a => ["tool_prune", "full_compaction"].includes(a.kind));
    expect(rebuilds).toHaveLength(rewrites.length);
    expect(rebuilds.every(a => a.afterTokens < a.triggerTokens)).toBe(true);
    const summaries = requests.filter(request => request.purpose === "compaction");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every(request => request.disableThinking === undefined)).toBe(true);
  });
  it("bounds tool results before their first send and preserves an evidence reference", async () => {
    const { result, requests, adjustments } = await trajectory(false, 50000, "accepted");
    expect(result.errorMessage).toBeUndefined();
    const firstTool = requests.find(r => r.messages.some(m => m.role === "tool"))!.messages.find(m => m.role === "tool");
    expect(JSON.stringify(firstTool).length).toBeLessThan(10000);
    expect(JSON.stringify(firstTool)).toContain("read-1");
    expect(adjustments.some(a => a.kind === "tool_result_bound")).toBe(true);
    const summaries = requests.filter(request => request.purpose === "compaction");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every(request => request.disableThinking === undefined)).toBe(true);
  });
  it("rejects malformed model summaries without replacing the original history", async () => {
    const { result, requests, compactions } = await trajectory(true);
    const summaries = requests.filter(r => r.purpose === "compaction");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.disableThinking).toBe(true);
    const input = summaries[0]!.messages[1]!.content[0]!;
    expect(input.type).toBe("text");
    if (input.type === "text") expect(() => JSON.parse(input.text)).not.toThrow();
    if (input.type === "text") expect(input.text).toContain("Inspect only, preserve this requirement.");
    expect(requests.at(-1)?.purpose).toBe("compaction");
    expect(compactions).toEqual([]);
    expect(result.errorMessage).toContain("context_summary_invalid_json");
    expectRetainedHistory(result, requests);
  });
});
