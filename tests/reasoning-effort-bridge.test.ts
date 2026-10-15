import { describe, expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";

describe("reasoning selection request isolation", () => {
  it("keeps selected effort on main turns while compaction requests explicitly disable thinking", async () => {
    const requests: ModelRequest[] = [];
    let turns = 0;
    const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "Fixture", maxContextTokens: 16384 });
    const provider: ModelProvider = { id: "fixture", listModels: async () => [model], health: async () => true, estimateCost: () => 0, supportsNonThinkingCompaction: () => true,
      async *stream(request) {
        requests.push(structuredClone(request));
        if (request.purpose === "compaction") {
          yield { type: "text_delta", delta: JSON.stringify({ goal: "Inspect source", constraints: ["read only"], decisions: [], evidence: [], completed: [], pending: ["Report findings"] }) };
          return;
        }
        turns++;
        yield { type: "reasoning_delta", delta: "reasoning ".repeat(600) };
        if (turns < 14) yield { type: "tool_call", toolCall: { id: `read-${turns}`, name: "read_file", input: { path: "source.ts" } } };
        else yield { type: "text_delta", delta: "done" };
      } };
    const result = await runWithPiAgent({ runId: "run", sessionId: "session", provider, model, reasoningEffort: "high",
      initialMessages: [{ role: "user", content: [{ type: "text", text: "Inspect source", trust: "user_request" }] }], contracts: [workflowReadTool.contract],
      resolveTool: () => workflowReadTool, externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: false,
      contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 },
      beforeToolCall: async () => ({}), executeTool: async () => ({ output: "source ".repeat(1000) }), shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    });
    expect(result.errorMessage).toBeUndefined();
    const summaries = requests.filter(request => request.purpose === "compaction"), main = requests.filter(request => request.purpose === "main");
    expect(summaries.length).toBeGreaterThan(0);
    expect(main).toHaveLength(14);
    expect(main.every(request => request.reasoningEffort === "high" && request.disableThinking === undefined)).toBe(true);
    expect(summaries.every(request => request.reasoningEffort === undefined && request.disableThinking === true)).toBe(true);
  });
});
