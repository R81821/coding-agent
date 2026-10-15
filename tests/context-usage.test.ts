import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { AgentEventSchema, type ContextAdjustment, type ContextUsage, type ModelMessage, type ModelRequest } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";
import { runtimeStopSummary } from "../packages/core/src/runtime-messages.js";

const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text, trust: "user_request" }] });
const summary = JSON.stringify({ goal: "Inspect the evidence", constraints: [], decisions: [], evidence: [], completed: [], pending: [] });

function fixture(respond: (request: ModelRequest, mainTurn: number) => ProviderStreamEvent[], capacity = 1_000_000) {
  const model = descriptor({ providerId: "fixture", modelId: "context", displayName: "Context fixture", maxContextTokens: capacity });
  const contexts: ContextUsage[] = [];
  const adjustments: ContextAdjustment[] = [];
  const requests: ModelRequest[] = [];
  let mainTurn = 0;
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "main") mainTurn++;
      for (const event of respond(request, mainTurn)) yield event;
    },
  };
  const options: PiAgentBridgeOptions = {
    runId: "context-run", sessionId: "context-session", model, provider, initialMessages: [user("Inspect the evidence")],
    contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 512,
    parallelToolCalls: false, beforeToolCall: async () => ({}), executeTool: async () => ({ output: "new evidence" }),
    shouldStopAfterTurn: () => false, onProviderEvent: () => {}, onContextUsage: value => { contexts.push(value); },
    onContextAdjustment: value => { adjustments.push(value); },
  };
  return { options, requests, contexts, adjustments };
}

describe("current context occupancy", () => {
  it("uses the latest main input plus output rather than cumulative run billing", async () => {
    const { options, contexts } = fixture((_request, turn) => [
      ...(turn === 1 ? [{ type: "tool_call" as const, toolCall: { id: "read", name: "read_file", input: { path: "evidence.ts" } } }] : [{ type: "text_delta" as const, delta: "Inspected." }]),
      { type: "usage", usage: { inputTokens: turn === 1 ? 400_000 : 490_000, outputTokens: turn === 1 ? 1_000 : 2_000, estimatedUsd: 0, purpose: "main" } },
    ]);
    options.contracts = [workflowReadTool.contract]; options.resolveTool = () => workflowReadTool;
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(contexts.filter(value => value.source === "provider").map(value => value.usedTokens)).toEqual([401_000, 492_000]);
    expect(contexts.at(-1)).toEqual({ usedTokens: 492_000, capacityTokens: 1_000_000, source: "provider" });
  });

  it.each([
    { capacity: 1_000_000, working: undefined, expected: 1_000_000 },
    { capacity: 1_000_000, working: 128_000, expected: 128_000 },
    { capacity: 16_384, working: 128_000, expected: 16_384 },
  ])("uses selected capacity $capacity and explicit working limit $working", async ({ capacity, working, expected }) => {
    const { options, contexts } = fixture(() => [{ type: "text_delta", delta: "Inspected." }], capacity);
    options.contextPolicy = { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1, ...(working === undefined ? {} : { workingContextTokens: working }) };
    expect((await runWithPiAgent(options)).errorMessage).toBeUndefined();
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every(value => value.capacityTokens === expected && value.source === "estimate")).toBe(true);
  });

  it("keeps the estimate when a provider reports only output usage", async () => {
    const { options, contexts } = fixture(() => [
      { type: "text_delta", delta: "Inspected." },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 100, estimatedUsd: 0, purpose: "main" } },
    ]);
    expect((await runWithPiAgent(options)).errorMessage).toBeUndefined();
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every(value => value.source === "estimate")).toBe(true);
  });

  it("reports fresh compacted occupancy before the next main request without counting summary usage", async () => {
    const { options, requests, contexts } = fixture(request => [
      { type: "text_delta", delta: request.purpose === "compaction" ? summary : "Inspected." },
      { type: "usage", usage: { inputTokens: request.purpose === "compaction" ? 12_000 : 1_000, outputTokens: request.purpose === "compaction" ? 900 : 30, estimatedUsd: 0, purpose: request.purpose } },
    ], 16_384);
    options.contextPolicy = { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 };
    options.resumeTranscript = [user("Inspect the evidence"), ...Array.from({ length: 10 }, (_, index): ModelMessage => ({ role: "assistant", content: [{ type: "text", text: `${index}: ${"x".repeat(3_000)}`, trust: "untrusted_tool" }] }))];
    let countAtCommit = 0;
    options.onCompaction = () => { countAtCommit = contexts.length; };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(requests.some(request => request.purpose === "compaction")).toBe(true);
    expect(contexts[0]!.usedTokens).toBeGreaterThan(16_384 * .8);
    expect(contexts[countAtCommit]).toMatchObject({ capacityTokens: 16_384, source: "estimate" });
    expect(contexts[countAtCommit]!.usedTokens).toBeLessThan(16_384 * .8);
    expect(contexts.filter(value => value.source === "provider")).toEqual([{ usedTokens: 1_030, capacityTokens: 16_384, source: "provider" }]);
  });

  it("retains the old occupancy when a compacted checkpoint cannot be saved", async () => {
    const { options, contexts } = fixture(() => [{ type: "text_delta", delta: summary }], 16_384);
    options.contextPolicy = { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1 };
    options.resumeTranscript = [user("Inspect the evidence"), ...Array.from({ length: 10 }, (): ModelMessage => ({ role: "assistant", content: [{ type: "text", text: "x".repeat(3_000), trust: "untrusted_tool" }] }))];
    options.onCompaction = () => { throw new Error("Checkpoint disk failure"); };
    expect((await runWithPiAgent(options)).errorMessage).toContain("Checkpoint disk failure");
    expect(contexts.at(-1)!.usedTokens).toBeGreaterThan(16_384 * .8);
    expect(contexts.every(value => value.source === "estimate")).toBe(true);
  });

  it("refreshes occupancy after removing a temporary stop instruction", async () => {
    const { options, contexts, adjustments } = fixture(() => [
      { type: "text_delta", delta: "Findings." },
      { type: "usage", usage: { inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0, purpose: "main" } },
    ]);
    options.afterAgentRun = async control => { await control.promptSummary(runtimeStopSummary("temporary stop " + "x".repeat(6_000))); };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(contexts.at(-2)).toEqual({ usedTokens: 1_100, capacityTokens: 1_000_000, source: "provider" });
    expect(contexts.at(-1)).toMatchObject({ capacityTokens: 1_000_000, source: "estimate" });
    const estimates = contexts.filter(value => value.source === "estimate");
    expect(estimates.at(-1)!.usedTokens).toBeLessThan(estimates.at(-2)!.usedTokens);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({
      kind: "runtime_control_removed",
      afterTokens: contexts.at(-1)!.usedTokens,
      capacityTokens: 1_000_000,
    });
  });

  it("does not report committed runtime removal when no temporary stop instruction was added", async () => {
    const { options, adjustments } = fixture(() => [
      { type: "text_delta", delta: "Findings." },
      { type: "usage", usage: { inputTokens: 1_000, outputTokens: 100, estimatedUsd: 0, purpose: "main" } },
    ]);
    options.afterAgentRun = async () => {};
    expect((await runWithPiAgent(options)).errorMessage).toBeUndefined();
    expect(adjustments).toEqual([]);
  });

  it("validates context telemetry independently of billing usage", () => {
    const event = { id: "context", runId: "run", sequence: 0, at: "2026-10-11T00:00:00.000Z", type: "context_usage", context: { usedTokens: 490_000, capacityTokens: 1_000_000, source: "provider" } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(AgentEventSchema.safeParse({ ...event, context: { ...event.context, capacityTokens: 0 } }).success).toBe(false);
    const removal = { ...event, type: "context_adjusted", adjustment: { kind: "runtime_control_removed", afterTokens: 490_000, capacityTokens: 1_000_000 } };
    expect(AgentEventSchema.parse(removal)).toMatchObject({ type: "context_adjusted", adjustment: removal.adjustment });
    expect(AgentEventSchema.safeParse({ ...removal, adjustment: { ...removal.adjustment, afterTokens: -1 } }).success).toBe(false);
  });
});
