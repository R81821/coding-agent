// Audit fixture: assertions intentionally confirm observed defects, not desired behavior.
// Copy to tests/agent-loop-audit.tmp.test.ts to run with the repository Vitest config.
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessEngine, ProjectTrustService, runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelMessage, type Profile, type RunSpec } from "@harness/protocol";
import { terminalTool, ToolRegistry } from "@harness/tools";

const makeModel = (maxContextTokens = 32_000) => descriptor({ providerId: "fake", modelId: "audit", displayName: "Audit", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens, dataPolicy: "local" } });
const initialMessages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Fix the login bug", trust: "user_request" }] }];
function bridgeOptions(provider: ModelProvider, model = makeModel()): PiAgentBridgeOptions {
  return { runId: "audit", sessionId: "audit", provider, model, initialMessages, contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal, maxOutputTokens: 200, parallelToolCalls: false, beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {} };
}

async function engineScenario(verificationFails: boolean) {
  const root = await mkdtemp(join(tmpdir(), "harness-loop-audit-"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "audit-password");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  try {
    const model = makeModel();
    let modelCalls = 0;
    let verificationCalls = 0;
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(): AsyncIterable<ProviderStreamEvent> { modelCalls++; yield { type: "text_delta", delta: `claimed done ${modelCalls}` }; }
    };
    const tools = new ToolRegistry().register({ ...terminalTool, async execute() { verificationCalls++; return { output: { exitCode: 1, stdout: "", stderr: "fixture failure", timedOut: false } }; } });
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["terminal"], verificationPolicy: { items: verificationFails ? [{ id: "test", command: "fixture-test", cwd: ".", timeoutMs: 1000, required: true, expectedExitCodes: [0] }] : [], maxRepairAttempts: 2 } };
    const run: RunSpec = { id: newId("audit"), sessionId: "audit", request: "Fix the login bug in this repository", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxTurns: 1 }, grants: [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture-test"], networkDomains: [], maxRisk: "high" }], createdAt: nowIso() };
    const result = await new Promise<AgentEvent>((resolveResult, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("audit timeout")); }, 5000);
      engine.on("event", (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); resolveResult(event); } });
      engine.start(run, profile);
    });
    await new Promise<void>((done) => setImmediate(done));
    return { result, modelCalls, verificationCalls, events: database.listEvents(run.id) };
  } finally {
    database.close(); vault.dispose();
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + "\\") && !target.startsWith(resolve(tmpdir()) + "/")) throw new Error("Audit cleanup outside temp root");
    await rm(target, { recursive: true, force: true });
  }
}

describe("temporary audit observations (assert current behavior, not desired behavior)", () => {
  it("repeats compaction, retains raw history, and drops summarizer usage from the callback", async () => {
    const model = makeModel(1000);
    let summaries = 0;
    let turns = 0;
    let chargedEvents = 0;
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        if (JSON.stringify(request.messages).includes("Summarize the supplied")) {
          summaries++;
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: 1 } };
          yield { type: "text_delta", delta: "Earlier files were inspected." };
        } else if (++turns === 1) yield { type: "tool_call", toolCall: { id: "read-1", name: "inspect", input: {} } };
        else yield { type: "text_delta", delta: "done" };
      }
    };
    const transcript: ModelMessage[] = [...initialMessages];
    for (let i = 0; i < 24; i++) transcript.push({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: `OLD_MARKER_${i} ${"history ".repeat(40)}`, trust: "untrusted_tool" }] });
    transcript.push({ role: "user", content: [{ type: "text", text: "continue", trust: "user_request" }] });
    const tool = { contract: { name: "inspect", description: "inspect", inputSchema: { type: "object", properties: {} }, risk: "read" as const, idempotent: true, timeoutMs: 1000 }, async execute() { return { output: "ok" }; } };
    const result = await runWithPiAgent({ ...bridgeOptions(provider, model), contracts: [tool.contract], resolveTool: () => tool, resumeTranscript: transcript, contextPolicy: { compactAtRatio: 0.7, maxAfterCompactionRatio: 0.8, retainRecentTurns: 2 }, getPinnedContext: () => "approved plan", onProviderEvent: (event) => { if (event.type === "usage") chargedEvents++; } });
    expect(summaries).toBe(2);
    expect(JSON.stringify(result.transcript)).toContain("OLD_MARKER_0");
    expect(chargedEvents).toBe(0);
  });

  it("treats terminal exit 1 as a successful pi tool execution", async () => {
    const model = makeModel();
    let turns = 0;
    let isError: boolean | undefined;
    let output: unknown;
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        if (++turns === 1) yield { type: "tool_call", toolCall: { id: "cmd-1", name: "terminal", input: { command: "exit 1" } } };
        else yield { type: "text_delta", delta: "done" };
      }
    };
    await runWithPiAgent({ ...bridgeOptions(provider, model), contracts: [terminalTool.contract], resolveTool: () => terminalTool,
      executeTool: async (call, tool, signal) => { const result = await tool.execute(call.input, { runId: "audit", workspacePath: process.cwd(), grants: [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["exit 1"], networkDomains: [], maxRisk: "high" }], signal }); output = result.output; return result; },
      onPiEvent: (event) => { if (event.type === "tool_execution_end") isError = event.isError; }
    });
    expect(output).toMatchObject({ exitCode: 1 });
    expect(isError).toBe(false);
  });

  it("loses the concrete thrown tool error before the next model request", async () => {
    const model = makeModel();
    let turns = 0;
    let nextRequest = "";
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        if (++turns === 1) yield { type: "tool_call", toolCall: { id: "read-1", name: "inspect", input: {} } };
        else { nextRequest = JSON.stringify(request.messages); yield { type: "text_delta", delta: "done" }; }
      }
    };
    const tool = { contract: { name: "inspect", description: "inspect", inputSchema: { type: "object", properties: {} }, risk: "read" as const, idempotent: true, timeoutMs: 1000 }, async execute() { throw new Error("UNIQUE_TOOL_FAILURE auth.ts:94 missing user"); } };
    await runWithPiAgent({ ...bridgeOptions(provider, model), contracts: [tool.contract], resolveTool: () => tool, executeTool: async () => tool.execute() });
    expect(nextRequest).toContain('"output":{}');
    expect(nextRequest).not.toContain("UNIQUE_TOOL_FAILURE");
  });

  it("makes three model calls despite maxTurns=1 during verification repair", async () => {
    const observed = await engineScenario(true);
    expect(observed.modelCalls).toBe(3);
    expect(observed.verificationCalls).toBe(3);
    expect(observed.result).toMatchObject({ status: "review", text: "claimed done 1claimed done 2claimed done 3" });
  });

  it("marks a coding request completed with no inspection, edits, or tests", async () => {
    const observed = await engineScenario(false);
    expect(observed.result).toMatchObject({ status: "completed" });
    expect(observed.verificationCalls).toBe(0);
    expect(observed.events.some((event) => event.type === "tool_started")).toBe(false);
  });
});
