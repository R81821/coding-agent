import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { ModelMessageSchema, type ModelMessage, type ModelRequest } from "@harness/protocol";
import { runtimeStopSummary, stripRuntimeSummaryMessages } from "../packages/core/src/runtime-messages.js";
import { workflowReadTool } from "./workflow-fixture.js";

const legacySummary = "Runtime stopping condition: verification configuration missing\nNo tools are available. Answer the original user request using only evidence already collected. State concrete findings and file paths, then unresolved questions and uninspected scope. Do not say you will keep exploring or claim the task is complete. Use the user's language.";
const userMessage = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text, trust: "user_request" }] });
const messageTexts = (messages: ModelMessage[]): string[] => messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []));

function fixture(respond: (request: ModelRequest, index: number) => ProviderStreamEvent[] = () => [{ type: "text_delta", delta: "Evidence reviewed." }]) {
  const requests: ModelRequest[] = [];
  const saved: ModelMessage[][] = [];
  const model = descriptor({ providerId: "fixture", modelId: "summary", displayName: "Summary fixture", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 8192, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const event of respond(request, requests.length)) yield event;
    },
  };
  const options: PiAgentBridgeOptions = {
    runId: "summary-run", sessionId: "summary-session", model, provider,
    initialMessages: [{ role: "system", content: [{ type: "text", text: "Inspect using collected evidence.", trust: "app_policy" }] }, userMessage("Inspect the memory issue and preserve the public API.")],
    contracts: [workflowReadTool.contract], resolveTool: () => workflowReadTool,
    externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: false,
    providerRetryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: "read evidence" }),
    shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    onTranscript: async messages => { saved.push(structuredClone(messages)); },
  };
  return { requests, saved, options };
}

describe("temporary runtime stop summaries", () => {
  it("round-trips the runtime marker through persisted message validation", () => {
    const message: ModelMessage = { ...userMessage(runtimeStopSummary("verification unavailable")), runtimePrompt: "stop_summary" };
    expect(ModelMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(ModelMessageSchema.parse(userMessage("ordinary request"))).toEqual(userMessage("ordinary request"));
  });

  it("removes marked user instructions and recognizes the exact legacy template", () => {
    const request = userMessage("Continue inspecting the original evidence.");
    const marked: ModelMessage = { ...userMessage("A future runtime summary format"), runtimePrompt: "stop_summary" };
    const evidence: ModelMessage = { role: "assistant", content: [{ type: "text", text: legacySummary, trust: "untrusted_tool" }] };
    expect(runtimeStopSummary("verification configuration missing")).toBe(legacySummary);
    expect(stripRuntimeSummaryMessages([request, marked, userMessage(legacySummary), evidence])).toEqual([request, evidence]);
  });

  it("preserves real user text, quoted templates, multipart messages, and explicitly protected exact text", () => {
    const ordinary = userMessage("Explain why the log says No tools are available.");
    const quoted = userMessage(`Explain this runtime message:\n${legacySummary}`);
    const suffix = userMessage(`${legacySummary}\nThis is a quoted log; diagnose it.`);
    const partial = userMessage("Runtime stopping condition: something failed\nNo tools are available.");
    const multipart: ModelMessage = { role: "user", content: [...userMessage(legacySummary).content, ...userMessage("Please explain this quote.").content] };
    const untrustedEvidence: ModelMessage = { role: "user", content: [{ type: "text", text: legacySummary, trust: "untrusted_tool" }] };
    const messages = [ordinary, quoted, suffix, partial, multipart, untrustedEvidence];
    expect(stripRuntimeSummaryMessages(messages)).toEqual(messages);
    expect(stripRuntimeSummaryMessages([userMessage(legacySummary)], [legacySummary])).toEqual([userMessage(legacySummary)]);
  });

  it.each(["resumeTranscript", "conversationHistory"] as const)("sanitizes legacy %s before the first provider request without losing evidence", async source => {
    const { options, requests, saved } = fixture();
    const request = "Continue checking cancellation and preserve the public API.";
    options[source] = [
      userMessage(request),
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "read-memory", name: "read_file", input: { path: "memory.ts" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "read-memory", output: { path: "memory.ts", finding: "listener survives cancellation" }, trust: "untrusted_tool" }] },
      userMessage(legacySummary),
      { role: "assistant", content: [{ type: "text", text: "Previous findings remain available.", trust: "untrusted_tool" }] },
    ];
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(messageTexts(requests[0]!.messages)).not.toContain(legacySummary);
    expect(messageTexts(requests[0]!.messages)).toContain(request);
    expect(JSON.stringify(requests[0]!.messages)).toContain("listener survives cancellation");
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(["read_file"]);
    for (const transcript of [...saved, result.transcript]) expect(messageTexts(transcript)).not.toContain(legacySummary);
  });

  it.each(["initialMessages", "recoveryUserTexts"] as const)("preserves an exact template actually supplied by the user through %s", async source => {
    const { options, requests, saved } = fixture();
    const staleSummary = runtimeStopSummary("a different runtime stop");
    options.resumeTranscript = [userMessage("Diagnose the supplied runtime log."), userMessage(legacySummary), userMessage(staleSummary)];
    if (source === "initialMessages") options.initialMessages.push(userMessage(legacySummary));
    else options.recoveryUserTexts = [legacySummary];
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    for (const transcript of [requests[0]!.messages, ...saved, result.transcript]) {
      expect(messageTexts(transcript)).toContain(legacySummary);
      expect(messageTexts(transcript)).not.toContain(staleSummary);
    }
  });

  it.each([false, true])("limits summary tools and clears the instruction before later work (provider failure: %s)", async failSummary => {
    const { options, requests, saved } = fixture((_request, index) => {
      if (failSummary && index === 2) throw new Error("summary provider rejected the request");
      return [{ type: "text_delta", delta: index === 2 ? "Collected findings: memory.ts needs a cancellation check." : "Evidence reviewed." }];
    });
    const summary = runtimeStopSummary("verification configuration missing");
    let afterSummary: ModelMessage[] = [];
    options.afterAgentRun = async control => {
      try { await control.promptSummary(summary); } catch (error) {
        if (!failSummary) throw error;
        expect(String(error)).toContain("summary provider rejected the request");
      }
      afterSummary = control.transcript();
      await control.promptUntrusted("Verification is now configured; continue the original task.");
    };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(["read_file"]);
    expect(requests[1]!.tools).toEqual([]);
    expect(messageTexts(requests[1]!.messages)).toContain(summary);
    expect(requests[2]!.tools.map(tool => tool.name)).toEqual(["read_file"]);
    expect(messageTexts(requests[2]!.messages)).not.toContain(summary);
    expect(messageTexts(requests[2]!.messages).some(text => text.includes("Verification is now configured"))).toBe(true);
    expect(saved.length).toBeGreaterThanOrEqual(3);
    for (const transcript of [...saved, afterSummary, result.transcript]) {
      expect(messageTexts(transcript)).not.toContain(summary);
      expect(transcript.some(message => message.runtimePrompt === "stop_summary")).toBe(false);
    }
    if (!failSummary) expect(messageTexts(result.transcript)).toContain("Collected findings: memory.ts needs a cancellation check.");
  });

  it("compacts a legacy checkpoint without promoting its stale summary to a protected user requirement", async () => {
    const { options, requests, saved } = fixture();
    const realUserRequest = "Keep cancellation semantics unchanged. The phrase No tools are available is diagnostic text.";
    const quotedTemplate = `Explain this quoted stopping instruction:\n${legacySummary}`;
    const history: ModelMessage[] = [userMessage("Inspect the memory issue and preserve the public API."), userMessage(legacySummary), userMessage(realUserRequest), userMessage(quotedTemplate)];
    for (let index = 0; index < 30; index++) history.push({ role: index % 2 ? "user" : "assistant", content: [{ type: "text", text: `old-observation-${index} ${"inspection evidence ".repeat(100)}`, trust: "untrusted_tool" }] });
    history.push(userMessage("Continue the investigation using retained evidence."));
    options.resumeTranscript = history;
    options.disableModelSummary = true;
    options.contextPolicy = { compactAtRatio: .7, maxAfterCompactionRatio: .5, retainRecentTurns: 1 };
    const compactions: ModelMessage[][] = [];
    options.onCompaction = async event => { compactions.push(event.after); };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(compactions.length).toBeGreaterThan(0);
    for (const transcript of [...compactions, ...saved, result.transcript, requests[0]!.messages]) {
      const texts = messageTexts(transcript);
      expect(texts).not.toContain(legacySummary);
      expect(texts).toContain(realUserRequest);
      expect(texts).toContain(quotedTemplate);
    }
  });

  it("keeps a currently active summary effective through compaction then removes it before another prompt", async () => {
    const { options, requests } = fixture((_request, index) => [{ type: "text_delta", delta: index === 1 ? "collected evidence ".repeat(1000) : "Collected findings." }]);
    const summary = runtimeStopSummary("time budget reached");
    options.disableModelSummary = true;
    options.contextPolicy = { compactAtRatio: .6, maxAfterCompactionRatio: .4, retainRecentTurns: 1 };
    let compactions = 0;
    options.onCompaction = async () => { compactions++; };
    options.afterAgentRun = async control => {
      await control.promptSummary(summary);
      await control.promptUntrusted("Additional verification is available.");
    };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    expect(compactions).toBeGreaterThan(0);
    expect(requests).toHaveLength(3);
    expect(requests[1]!.tools).toEqual([]);
    expect(messageTexts(requests[1]!.messages)).toContain(summary);
    expect(requests[2]!.tools.map(tool => tool.name)).toEqual(["read_file"]);
    expect(messageTexts(requests[2]!.messages)).not.toContain(summary);
    expect(messageTexts(result.transcript)).not.toContain(summary);
  });

  it("excludes the active stop instruction from the model compaction request and saved compacted history", async () => {
    const { options, requests, saved } = fixture((request, index) => [{ type: "text_delta", delta: request.purpose === "compaction"
      ? JSON.stringify({ goal: "Inspect the memory issue", constraints: ["Preserve the public API"], decisions: [], evidence: [], completed: [], pending: ["Check cancellation"] })
      : index === 1 ? "collected evidence ".repeat(1000) : "Collected findings." }]);
    const summary = runtimeStopSummary("time budget reached");
    options.provider.supportsNonThinkingCompaction = () => true;
    options.conversationHistory = [userMessage("Inspect the memory issue.")];
    for (let index = 0; index < 8; index++) options.conversationHistory.push({ role: "assistant", content: [{ type: "text", text: `Retained observation ${index}: inspect the cancellation listener.`, trust: "untrusted_tool" }] });
    options.contextPolicy = { compactAtRatio: .6, maxAfterCompactionRatio: .4, retainRecentTurns: 1 };
    const compacted: ModelMessage[][] = [];
    options.onCompaction = async event => { compacted.push(event.before, event.after); };
    options.afterAgentRun = async control => {
      await control.promptSummary(summary);
      await control.promptUntrusted("Additional verification is available.");
    };
    const result = await runWithPiAgent(options);
    expect(result.errorMessage).toBeUndefined();
    const compactionRequests = requests.filter(request => request.purpose === "compaction");
    expect(compactionRequests).toHaveLength(1);
    const compactionText = messageTexts(compactionRequests[0]!.messages).join("\n");
    expect(compactionText).toContain("Retained observation");
    expect(compactionText).not.toContain("Runtime stopping condition:");
    expect(compactionText).not.toContain("No tools are available");
    expect(compactionText).not.toContain("stop_summary");
    const mainRequests = requests.filter(request => request.purpose === "main");
    expect(mainRequests).toHaveLength(3);
    expect(mainRequests[1]!.tools).toEqual([]);
    expect(messageTexts(mainRequests[1]!.messages)).toContain(summary);
    expect(mainRequests[2]!.tools.map(tool => tool.name)).toEqual(["read_file"]);
    for (const transcript of [...compacted, ...saved, result.transcript, mainRequests[2]!.messages]) {
      expect(messageTexts(transcript)).not.toContain(summary);
      expect(transcript.some(message => message.runtimePrompt === "stop_summary")).toBe(false);
    }
  });
});
