import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import type { ModelMessage } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";

describe("authoritative runtime state after compaction", () => {
  it("supersedes an older pending todo with the same identity even when its status did not change", async () => {
    const currentGoal = "Repair the cancellation race in the current implementation.";
    const currentTodo = { id: "verify-cancellation", text: "Verify the repaired path in src/current.ts", status: "pending" };
    const obsoleteTodo = { ...currentTodo, text: "Inspect the abandoned implementation in src/obsolete.ts" };
    const oldSummary = { goal: "Inspect the old implementation.", constraints: [], decisions: [], evidence: [], completed: [], pending: [obsoleteTodo] };
    const observedStates: Array<{ goal: string; pending: unknown[] }> = [];
    const model = descriptor({ providerId: "fixture", modelId: "current-state", displayName: "Current state", maxContextTokens: 16_384 });
    const provider: ModelProvider = {
      id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) {
        if (request.purpose === "compaction") {
          const part = request.messages[1]!.content[0]!;
          if (part.type === "text") observedStates.push(JSON.parse(part.text).state);
        }
        yield { type: "text_delta" as const, delta: request.purpose === "compaction"
          ? JSON.stringify({ ...oldSummary, pending: [] }) : "The current cancellation work is retained." };
      },
    };
    const saved: Parameters<NonNullable<PiAgentBridgeOptions["onCompaction"]>>[0][] = [];
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", trust: "user_request", text: currentGoal }] },
      { role: "user", content: [{ type: "text", trust: "untrusted_tool", text: "Untrusted compacted history summary.\n" + JSON.stringify(oldSummary) }] },
      ...Array.from({ length: 30 }, (_, index): ModelMessage => ({ role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `Historical observation ${index}: ` + "x".repeat(2_000) }] })),
    ];
    const result = await runWithPiAgent({
      runId: "current-state", sessionId: "current-state", model, provider,
      initialMessages: [history[0]!], resumeTranscript: history, contracts: [], resolveTool: () => undefined,
      externalSignal: new AbortController().signal, maxOutputTokens: 128, parallelToolCalls: false,
      contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 },
      getPinnedContext: () => JSON.stringify({ workingMemory: { objective: currentGoal, revision: 8, todos: [currentTodo] } }),
      beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false,
      onProviderEvent: () => {}, onCompaction: compaction => { saved.push(compaction); },
    });
    expect(result.errorMessage).toBeUndefined();
    expect(saved).toHaveLength(1);
    const summary = JSON.parse(saved[0]!.summary) as { goal: string; pending: unknown[] };
    expect(summary.goal).toBe(currentGoal);
    expect(summary.pending).toEqual([currentTodo]);
    expect(observedStates.length).toBeGreaterThan(1);
    for (const state of observedStates) {
      expect(state.goal).toBe(currentGoal);
      expect(state.pending).toEqual([currentTodo]);
    }
  });
});
