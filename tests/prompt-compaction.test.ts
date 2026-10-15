import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, ProviderOutputTruncatedError, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

const userRequest = "Repair the race without changing the public API; keep the earlier failure causes and verification results.";
const marker = (index: number) => `IMPORTANT_RECORD_${String(index).padStart(3, "0")}`;
const summaryFor = (constraints: string[] = []) => ({
  goal: "Finish the repair while preserving the investigation.", constraints,
  decisions: [], evidence: [], completed: [], pending: ["Verify the repaired cancellation path."],
});

function compactionPayload(request: ModelRequest): { records: ModelMessage[]; [key: string]: unknown } {
  const text = request.messages.filter(message => message.role === "user").flatMap(message => message.content)
    .filter(part => part.type === "text").map(part => part.type === "text" ? part.text : "").join("\n");
  return JSON.parse(text) as { records: ModelMessage[]; [key: string]: unknown };
}

function estimatedInput(request: ModelRequest): number {
  const payload = JSON.stringify({ messages: request.messages, tools: request.tools });
  const ascii = payload.replace(/[^\x00-\x7f]/g, "").length;
  return Math.ceil(ascii / 2 + Buffer.byteLength(payload, "utf8") - ascii);
}

async function fixture(options: {
  capacity?: number; modelOutput?: number | undefined; workingContext?: number; recordCharacters?: number; recordCount?: number;
  historicalPrefix?: ModelMessage[];
  summary?: (request: ModelRequest, turn: number) => string;
}) {
  const capacity = options.capacity ?? 1_000_000;
  const model = descriptor({ providerId: "fixture", modelId: "prompt-summary", displayName: "prompt-summary", capabilities: {
    vision: false, tools: true, parallelTools: false, structuredOutput: true, dataPolicy: "local", maxContextTokens: capacity,
    ...(options.modelOutput === undefined ? {} : { maxOutputTokens: options.modelOutput }),
  } });
  const records: ModelMessage[] = [...(options.historicalPrefix ?? []), ...Array.from({ length: options.recordCount ?? 60 }, (_, index): ModelMessage => ({
    role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `${marker(index)}: observed failure cause, rejected approach, repaired file and verified outcome. ` + "x".repeat(options.recordCharacters ?? 4_096) }],
  }))];
  const requests: ModelRequest[] = [];
  const compactions: Parameters<NonNullable<PiAgentBridgeOptions["onCompaction"]>>[0][] = [];
  let summaryTurns = 0;
  const provider: ModelProvider = {
    id: "fixture", supportsNonThinkingCompaction: () => true,
    async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.purpose === "compaction") {
        summaryTurns += 1;
        yield { type: "text_delta" as const, delta: options.summary?.(request, summaryTurns) ?? JSON.stringify(summaryFor()) };
      } else yield { type: "text_delta" as const, delta: "The investigation is retained." };
    },
  };
  const result = await runWithPiAgent({
    runId: "prompt-summary", sessionId: "prompt-summary", provider, model,
    initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: userRequest }] }],
    resumeTranscript: [{ role: "user", content: [{ type: "text", trust: "user_request", text: userRequest }] }, ...records],
    contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal,
    maxOutputTokens: 200, parallelToolCalls: false,
    contextPolicy: { compactAtRatio: .8, maxAfterCompactionRatio: .45, retainRecentTurns: 1,
      ...(options.workingContext === undefined ? {} : { workingContextTokens: options.workingContext }) },
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false,
    onProviderEvent: () => {}, onCompaction: event => { compactions.push(event); },
  });
  return { result, records, requests, summaries: requests.filter(request => request.purpose === "compaction"), compactions };
}

describe("prompt-led history summaries", () => {
  it.each([24_576, undefined])("sends the complete large transcript and accepts a detailed summary (model output=%s)", async modelOutput => {
    const generated = {
      ...summaryFor(Array.from({ length: 140 }, (_, index) => `Requirement ${index}: retain its evidence and public compatibility guarantees. ${"x".repeat(40)}`)),
      goal: "COMPLETE_INVESTIGATION_MARKER: " + "g".repeat(4_500),
      decisions: [{ decision: "Keep the cancellation guard.", reason: "IMPORTANT_FAILURE_CAUSE_MARKER: " + "r".repeat(4_500) }],
      evidence: ["packages/core/src/task.ts:42"], completed: ["VERIFIED_FIX_MARKER: the delayed callback race passes its regression."],
      pending: ["REJECTED_ALTERNATIVE_MARKER: do not replace the lock with an unchecked retry."],
    };
    expect(JSON.stringify(generated).length).toBeGreaterThan(16_000);
    const { result, records, summaries, compactions } = await fixture({ modelOutput, workingContext: 128_000, summary: () => JSON.stringify(generated) });
    expect(result.errorMessage).toBeUndefined();
    expect(summaries).toHaveLength(1);
    const request = summaries[0]!;
    const payload = compactionPayload(request);
    expect(JSON.stringify(payload.records).length).toBeGreaterThan(120_000);
    expect(payload.records.filter(message => message.role === "assistant")).toEqual(records);
    expect(request.maxOutputTokens).toBeGreaterThan(2_048);
    expect(request.maxOutputTokens).toBeGreaterThan(200);
    expect(request.maxOutputTokens + estimatedInput(request)).toBeLessThanOrEqual(1_000_000);
    if (modelOutput !== undefined) expect(request.maxOutputTokens).toBe(modelOutput);
    expect(request).toMatchObject({ disableThinking: true, tools: [], store: false });
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ deterministicFallback: false, summaryOutcome: "accepted" });
    expect(compactions[0]!.outputTokens).toBeGreaterThan(2_048);
    const saved = JSON.parse(compactions[0]!.summary) as typeof generated;
    expect(saved.goal).toBe(generated.goal);
    expect(saved.constraints).toEqual(expect.arrayContaining(generated.constraints));
    expect(saved.decisions).toEqual(expect.arrayContaining(generated.decisions));
    for (const fact of ["IMPORTANT_FAILURE_CAUSE_MARKER", "VERIFIED_FIX_MARKER", "REJECTED_ALTERNATIVE_MARKER", userRequest]) {
      expect(JSON.stringify(result.transcript)).toContain(fact);
    }
    const prompt = request.messages.filter(message => message.role === "system").flatMap(message => message.content)
      .filter(part => part.type === "text").map(part => part.type === "text" ? part.text : "").join("\n");
    expect(prompt).toMatch(/preserv|retain/i);
    expect(prompt).toMatch(/reject|alternative/i);
    expect(prompt).toMatch(/error|failure/i);
    expect(prompt).toMatch(/verif/i);
    expect(prompt).toMatch(/complet|self.check/i);
  });

  it("processes an oversized history in order and carries all earlier facts into later summaries", async () => {
    const { result, records, summaries, requests, compactions } = await fixture({
      capacity: 16_384, modelOutput: 4_096, recordCharacters: 3_000, recordCount: 30,
      summary: request => JSON.stringify(summaryFor([...new Set(JSON.stringify(compactionPayload(request)).match(/IMPORTANT_RECORD_\d+/g) ?? [])])),
    });
    expect(result.errorMessage).toBeUndefined();
    expect(summaries.length).toBeGreaterThan(1);
    const submitted = summaries.flatMap(request => compactionPayload(request).records);
    expect(submitted.filter(message => message.role === "assistant")).toEqual(records);
    expect(requests.some(request => request.purpose === "main")).toBe(true);
    for (const request of summaries) {
      expect(compactionPayload(request).records.length).toBeGreaterThan(0);
      expect(estimatedInput(request) + request.maxOutputTokens).toBeLessThanOrEqual(16_384);
      expect(request.maxOutputTokens).toBeLessThanOrEqual(4_096);
    }
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ summaryOutcome: "accepted", deterministicFallback: false });
    for (let index = 0; index < records.length; index += 1) expect(compactions[0]!.summary).toContain(marker(index));
  });

  it("uses a model's actual 4096-token output ceiling for a summary", async () => {
    const { result, summaries } = await fixture({ modelOutput: 4_096, workingContext: 128_000 });
    expect(result.errorMessage).toBeUndefined();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.maxOutputTokens).toBe(4_096);
  });

  it("summarizes full historical error evidence and preserves its identity alongside model facts", async () => {
    const failedOutput = {
      isError: true, cause: "IMPORTANT_TOOL_FAILURE_CAUSE_MARKER: cancellation raced with persistence.",
      fix: "VERIFIED_TOOL_REPAIR_MARKER: guard the commit and rerun the delayed callback test.",
      trace: "x".repeat(20_000),
    };
    const { result, summaries, compactions } = await fixture({
      workingContext: 128_000, historicalPrefix: [
        { role: "assistant", content: [{ type: "tool_call", toolCallId: "historical-failure", name: "terminal", input: { command: "verify cancellation" } }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "historical-failure", trust: "untrusted_tool", output: failedOutput }] },
      ],
      summary: () => JSON.stringify({ ...summaryFor([userRequest]), evidence: ["MODEL_GENERATED_EVIDENCE_MARKER"], decisions: [failedOutput.cause], completed: [failedOutput.fix] }),
    });
    expect(result.errorMessage).toBeUndefined();
    expect(summaries).toHaveLength(1);
    const payload = compactionPayload(summaries[0]!);
    expect(JSON.stringify(payload.records)).toContain(failedOutput.cause);
    expect(JSON.stringify(payload.records)).toContain(failedOutput.fix);
    expect(JSON.stringify(payload.records)).toContain(failedOutput.trace);
    const saved = JSON.parse(compactions[0]!.summary) as { evidence: unknown[] };
    expect(saved.evidence).toEqual(expect.arrayContaining(["MODEL_GENERATED_EVIDENCE_MARKER", expect.objectContaining({ id: "historical-failure", failed: true })]));
    for (const fact of [failedOutput.cause, failedOutput.fix, userRequest]) expect(JSON.stringify(result.transcript)).toContain(fact);
  });

  it("preserves reasoning-only historical records in summary input, archives and failed recovery", async () => {
    const reasoning = "REASONING_ONLY_IMPORTANT_CAUSE_MARKER: the deferred commit bypassed cancellation checks.";
    const reasoningRecord: ModelMessage = { role: "assistant", content: [], reasoningContent: reasoning };
    const accepted = await fixture({
      workingContext: 128_000, historicalPrefix: [reasoningRecord],
      summary: () => JSON.stringify({ ...summaryFor(), decisions: [reasoning] }),
    });
    expect(accepted.result.errorMessage).toBeUndefined();
    expect(accepted.summaries).toHaveLength(1);
    const source = compactionPayload(accepted.summaries[0]!).records;
    expect(source.filter(message => message.reasoningContent === reasoning)).toEqual([reasoningRecord]);
    expect(accepted.compactions).toHaveLength(1);
    expect(accepted.compactions[0]!.before.filter(message => message.reasoningContent === reasoning)).toEqual([reasoningRecord]);
    expect(JSON.stringify(accepted.result.transcript)).toContain(reasoning);

    const failed = await fixture({ workingContext: 128_000, historicalPrefix: [reasoningRecord], summary: () => "Invalid continuation summary." });
    expect(failed.result.errorMessage).toContain("context_summary_invalid_json");
    expect(failed.compactions).toEqual([]);
    expect(failed.requests.some(request => request.purpose === "main")).toBe(false);
    expect(failed.result.transcript.filter(message => message.reasoningContent === reasoning)).toEqual([reasoningRecord]);
  });

  it("preserves an accepted informative summary above the preferred post-compaction target", async () => {
    const generated = { ...summaryFor(), goal: "IMPORTANT_ACCEPTED_NARRATIVE_MARKER: " + "g".repeat(130_000) };
    const { result, requests, compactions } = await fixture({ modelOutput: 65_536, workingContext: 128_000, summary: () => JSON.stringify(generated) });
    expect(result.errorMessage).toBeUndefined();
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ summaryOutcome: "accepted", deterministicFallback: false });
    expect(JSON.parse(compactions[0]!.summary).goal).toBe(generated.goal);
    const main = requests.findLast(request => request.purpose === "main")!;
    expect(estimatedInput(main)).toBeGreaterThan(57_600);
    expect(estimatedInput(main)).toBeLessThan(102_400);
    expect(JSON.stringify(main.messages)).toContain(generated.goal);
    expect(JSON.stringify(result.transcript)).toContain(generated.goal);
  });

  it.each(["invalid_json", "truncated"] as const)("retains original narrative when a later summary batch is %s", async failure => {
    const { result, records, requests, summaries, compactions } = await fixture({
      capacity: 16_384, modelOutput: 4_096, recordCharacters: 3_000, recordCount: 30,
      summary: (request, turn) => {
        if (turn === 1) return JSON.stringify(summaryFor([...new Set(JSON.stringify(compactionPayload(request)).match(/IMPORTANT_RECORD_\d+/g) ?? [])]));
        if (failure === "truncated") throw new ProviderOutputTruncatedError("length");
        return "This summary omitted the earlier repair narrative.";
      },
    });
    expect(summaries).toHaveLength(2);
    expect(result.errorMessage).toBeDefined();
    expect(requests.some(request => request.purpose === "main")).toBe(false);
    expect(compactions).toEqual([]);
    for (const record of records) {
      const text = record.content[0];
      if (text?.type === "text") expect(JSON.stringify(result.transcript)).toContain(text.text);
    }
  });
});
