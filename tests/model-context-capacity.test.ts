import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ContextAdjustment, ModelMessage, ModelRequest } from "@harness/protocol";

const requestText = "Continue the inspection and preserve the collected evidence.";
const historicalToolOutput = { text: "TOOL_EVIDENCE_MARKER:" + "x".repeat(5_000) };

function history(textCharacters: number): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", trust: "user_request", text: requestText }] },
    { role: "assistant", content: [{ type: "tool_call", toolCallId: "historical-read", name: "read_file", input: { path: "example.ts" } }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "historical-read", trust: "untrusted_tool", output: historicalToolOutput }] },
    ...Array.from({ length: 12 }, (_, index): ModelMessage => ({
      role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `HISTORY_MARKER_${index}:` + "x".repeat(textCharacters) }],
    })),
  ];
}

async function resumedRun(modelCapacity: number, textCharacters: number, workingContextTokens?: number) {
  const model = descriptor({ providerId: "fixture", modelId: "capacity", displayName: "capacity", maxContextTokens: modelCapacity });
  const requests: ModelRequest[] = [];
  const adjustments: ContextAdjustment[] = [];
  let compactions = 0;
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "text_delta" as const, delta: request.purpose === "compaction" ? JSON.stringify({
        goal: "Continue the inspection.", constraints: [requestText], decisions: [], evidence: ["historical-read"],
        completed: [], pending: ["Finish the inspection."],
      }) : "Inspection continued." };
    },
  };
  const contextPolicy: NonNullable<PiAgentBridgeOptions["contextPolicy"]> = {
    compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1,
    ...(workingContextTokens === undefined ? {} : { workingContextTokens }),
  };
  const result = await runWithPiAgent({
    runId: "capacity-run", sessionId: "capacity-session", model, provider,
    initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: requestText }] }],
    resumeTranscript: history(textCharacters), contracts: [], resolveTool: () => undefined,
    externalSignal: new AbortController().signal, maxOutputTokens: 512, parallelToolCalls: false, contextPolicy,
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false,
    onProviderEvent: () => {}, onContextAdjustment: adjustment => { adjustments.push(adjustment); },
    onCompaction: () => { compactions += 1; },
  });
  expect(result.errorMessage).toBeUndefined();
  return { result, requests, adjustments, compactions };
}

describe("selected model context capacity", () => {
  it("preserves large-model history beyond the former default threshold", async () => {
    const { result, requests, adjustments, compactions } = await resumedRun(480_000, 20_000);
    expect(requests.map(request => request.purpose)).toEqual(["main"]);
    const input = requests[0]!;
    // The bridge's cautious ASCII estimate is above the former 128,000 * .8
    // trigger, while remaining safely below the selected model's trigger.
    const estimatedInput = Math.ceil(JSON.stringify({ messages: input.messages, tools: input.tools }).length / 2);
    expect(estimatedInput).toBeGreaterThan(102_400);
    expect(estimatedInput).toBeLessThan(384_000);
    expect(adjustments).toEqual([]);
    expect(compactions).toBe(0);
    for (const messages of [input.messages, result.transcript]) {
      const toolResult = messages.flatMap(message => message.content).find(part => part.type === "tool_result");
      expect(toolResult).toMatchObject({ output: historicalToolOutput });
      const oldestHistory = messages.flatMap(message => message.content).find(part => part.type === "text" && part.text.startsWith("HISTORY_MARKER_0:"));
      expect(oldestHistory).toMatchObject({ text: "HISTORY_MARKER_0:" + "x".repeat(20_000) });
    }
  });

  it.each([
    { modelCapacity: 480_000, textCharacters: 65_000, workingContextTokens: undefined, capacityTokens: 480_000, triggerTokens: 384_000, targetTokens: 216_000 },
    { modelCapacity: 480_000, textCharacters: 20_000, workingContextTokens: 128_000, capacityTokens: 128_000, triggerTokens: 102_400, targetTokens: 57_600 },
    { modelCapacity: 16_384, textCharacters: 3_000, workingContextTokens: undefined, capacityTokens: 16_384, triggerTokens: 13_107, targetTokens: 7_372 },
    { modelCapacity: 16_384, textCharacters: 3_000, workingContextTokens: 128_000, capacityTokens: 16_384, triggerTokens: 13_107, targetTokens: 7_372 },
  ])("compacts at model=$modelCapacity, explicit working context=$workingContextTokens", async ({ modelCapacity, textCharacters, workingContextTokens, capacityTokens, triggerTokens, targetTokens }) => {
    const { requests, adjustments, compactions } = await resumedRun(modelCapacity, textCharacters, workingContextTokens);
    expect(compactions).toBe(1);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ kind: "full_compaction", capacityTokens, triggerTokens, targetTokens });
    expect(adjustments[0]!.beforeTokens).toBeGreaterThanOrEqual(triggerTokens);
    expect(adjustments[0]!.afterTokens).toBeLessThanOrEqual(targetTokens);
    expect(JSON.stringify(requests[0]!.messages)).toContain(requestText);
  });
});
