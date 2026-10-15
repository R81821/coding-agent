import { describe, expect, it, vi } from "vitest";
import type { ModelMessage, ModelRequest } from "@harness/protocol";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { summarizeContext, validContextSummary, type ContextSummaryOptions } from "../packages/core/src/context-summary.js";
import { estimateRequestInputTokens } from "../packages/core/src/generation-policy.js";

const generated = { goal: "Continue the investigation.", constraints: [], decisions: [], evidence: [], completed: [], pending: [] };
const required = JSON.stringify({ ...generated, runtime: { revision: 7, checks: { verified: true } } });
const message = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text }] });

function payload(request: ModelRequest): { task: string[]; state: Record<string, unknown>; records: ModelMessage[] } {
  const part = request.messages[1]!.content[0]!;
  if (part.type !== "text") throw new Error("Expected a serialized compaction request");
  return JSON.parse(part.text);
}

function fixture(input: {
  capacity?: number;
  output?: number;
  nonThinking?: boolean;
  response?(request: ModelRequest, turn: number): ProviderStreamEvent[];
} = {}) {
  const model = descriptor({ providerId: "fixture", modelId: "summary-budget", displayName: "Summary budget", capabilities: {
    vision: false, tools: true, parallelTools: false, structuredOutput: true, dataPolicy: "local",
    maxContextTokens: input.capacity ?? 1_000_000,
    ...(input.output === undefined ? {} : { maxOutputTokens: input.output }),
  } });
  const requests: ModelRequest[] = [];
  const events: ProviderStreamEvent[] = [];
  const controller = new AbortController();
  const merge = vi.fn((previous: string, next: string): string => JSON.stringify({ ...JSON.parse(previous), ...JSON.parse(next) }));
  const provider: ModelProvider = {
    id: "fixture", supportsNonThinkingCompaction: () => input.nonThinking ?? false,
    async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const event of input.response?.(request, requests.length) ?? [{ type: "text_delta", delta: JSON.stringify(generated) }]) yield event;
    },
  };
  const options: ContextSummaryOptions = {
    model, provider, runId: "summary-budget", messages: [], task: ["Continue safely and preserve the investigation."],
    state: required, merge, signal: controller.signal,
    onProviderEvent: event => { events.push(event); },
  };
  return { options, requests, events, controller, merge };
}

function boundaryCapacity(inputTokens: number, outputTokens = 1): number {
  let capacity = inputTokens + outputTokens;
  while (true) {
    const adjusted = inputTokens + outputTokens + Math.min(1024, Math.floor(capacity / 16));
    if (adjusted === capacity) return capacity;
    capacity = adjusted;
  }
}

describe("continuation summary request budgets", () => {
  it.each([
    { label: "Unicode", body: "路径核验错误原因🧪".repeat(110) },
    { label: "nested JSON escaping", body: '"\\\n\t\u0000'.repeat(500) },
  ])("preserves every $label record and budgets each complete chronological batch", async ({ body }) => {
    const { options, requests } = fixture({ capacity: 8_192, output: 1_024 });
    const records = Array.from({ length: 20 }, (_, index) => message(`record-${index}: ${body}`));
    options.messages = records;
    const result = await summarizeContext(options);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap(request => payload(request).records)).toEqual(records);
    expect(JSON.parse(result).runtime).toEqual({ revision: 7, checks: { verified: true } });
    for (const request of requests) {
      expect(request.maxOutputTokens).toBeGreaterThan(0);
      expect(request.maxOutputTokens).toBeLessThanOrEqual(1_024);
      expect(estimateRequestInputTokens(request) + request.maxOutputTokens + 512).toBeLessThanOrEqual(8_192);
      expect(request).not.toHaveProperty("disableThinking");
      expect(request).not.toHaveProperty("reasoningEffort");
    }
  });

  it("splits a history that physically fits with only one output token to retain the available model output capacity", async () => {
    const records = [message("A:" + "a".repeat(20_000)), message("B:" + "b".repeat(20_000))];
    const calibration = fixture({ output: 4_096 });
    calibration.options.messages = records;
    await summarizeContext(calibration.options);
    const capacity = boundaryCapacity(estimateRequestInputTokens(calibration.requests[0]!));
    const { options, requests } = fixture({ capacity, output: 4_096 });
    options.messages = records;
    await summarizeContext(options);
    expect(requests).toHaveLength(2);
    expect(requests.flatMap(request => payload(request).records)).toEqual(records);
    expect(requests.map(request => request.maxOutputTokens)).toEqual([4_096, 4_096]);
  });

  it("allows a complete record at the physical boundary when a preferred reservation cannot fit it", async () => {
    const first = message("LARGE_RECORD:" + "x".repeat(8_000));
    const calibration = fixture();
    calibration.options.messages = [first];
    await summarizeContext(calibration.options);
    const capacity = boundaryCapacity(estimateRequestInputTokens(calibration.requests[0]!));
    const { options, requests } = fixture({ capacity, output: 4_096 });
    options.messages = [first, message("The next record also survives.")];
    await summarizeContext(options);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.maxOutputTokens).toBe(1);
    expect(requests.flatMap(request => payload(request).records)).toEqual(options.messages);
    for (const request of requests) expect(estimateRequestInputTokens(request) + request.maxOutputTokens + Math.floor(capacity / 16)).toBeLessThanOrEqual(capacity);
  });

  it("refuses a truly oversized record without submitting a partial record", async () => {
    const { options, requests, merge } = fixture({ capacity: 4_096 });
    options.messages = [message("IMPORTANT_OVERSIZED_RECORD:" + "x".repeat(20_000))];
    await expect(summarizeContext(options)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(requests).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
    expect(options.messages[0]).toEqual(message("IMPORTANT_OVERSIZED_RECORD:" + "x".repeat(20_000)));
  });

  it("refuses task and state that cannot fit even before submitting history", async () => {
    const { options, requests } = fixture({ capacity: 4_096 });
    options.task = ["Preserve this entire task. " + "x".repeat(10_000)];
    await expect(summarizeContext(options)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(requests).toEqual([]);
  });
});

describe("continuation summary completion", () => {
  it.each([
    { response: "", code: "context_summary_empty" },
    { response: "null", code: "context_summary_invalid_json" },
    { response: "{}", code: "context_summary_invalid_json" },
    { response: JSON.stringify({ ...generated, constraints: [false] }), code: "context_summary_invalid_json" },
    { response: JSON.stringify({ ...generated, evidence: [{ id: "tool-1", failed: "yes" }] }), code: "context_summary_invalid_json" },
    { response: JSON.stringify({ ...generated, pending: [{ text: "Continue", unsupported: true }] }), code: "context_summary_invalid_json" },
    { response: JSON.stringify({ ...generated, runtime: {} }), code: "context_summary_invalid_json" },
  ])("rejects incomplete or malformed output without merging it ($response)", async ({ response, code }) => {
    const { options, merge } = fixture({ response: () => [{ type: "text_delta", delta: response }] });
    options.messages = [message("Important investigation.")];
    await expect(summarizeContext(options)).rejects.toMatchObject({ code });
    expect(merge).not.toHaveBeenCalled();
  });

  it("stops before provider dispatch when the request budget refuses compaction", async () => {
    const { options, requests } = fixture();
    options.beforeRequest = () => false;
    await expect(summarizeContext(options)).rejects.toMatchObject({ code: "context_summary_budget_exhausted" });
    expect(requests).toEqual([]);
  });

  it.each(["before request", "during response"] as const)("rejects cancellation %s without accepting a partial summary", async when => {
    const { options, controller, requests, merge } = fixture({ response: () => {
      controller.abort();
      return [{ type: "text_delta", delta: JSON.stringify(generated) }];
    } });
    if (when === "before request") controller.abort();
    await expect(summarizeContext(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(when === "before request" ? 0 : 1);
    expect(merge).not.toHaveBeenCalled();
  });

  it("accepts unlimited descriptive JSON strings while keeping all records untrusted", () => {
    expect(validContextSummary(JSON.stringify({
      ...generated, goal: "g".repeat(20_000), constraints: Array.from({ length: 140 }, () => "Retain every material requirement."),
      decisions: [{ decision: "Inspect the literal tool_call and DSML markers.", reason: "r".repeat(5_000) }],
    }))).toBe(true);
  });

  it("forwards compaction usage and cache diagnostics and only requests supported thinking controls", async () => {
    const { options, events, requests } = fixture({ nonThinking: true, response: () => [
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0 } },
      { type: "cache_diagnostic" },
      { type: "text_delta", delta: JSON.stringify(generated) },
    ] });
    await summarizeContext(options);
    expect(requests[0]).toMatchObject({ purpose: "compaction", disableThinking: true, cacheDiagnostics: true });
    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20, estimatedUsd: 0, purpose: "compaction" } },
      { type: "cache_diagnostic" },
    ]);
  });
});
