import { workflowPrelude } from "./workflow-fixture.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService, runWithPiAgent } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunBudget, type RunSpec } from "@harness/protocol";
import { terminalTool, ToolRegistry, type ToolDefinition } from "@harness/tools";
import { RunProgress } from "../packages/core/src/run-progress.js";
import { assistantMessages } from "../apps/desktop/src/assistant-messages.js";

const readTool: ToolDefinition = {
  contract: { name: "read_file", description: "fixture read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
  async execute(input) { return { output: `contents of ${input.path}` }; },
};
const read = (id: string, path = "src/auth.ts"): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name: "read_file", input: { path } } });
const say = (delta: string): ProviderStreamEvent => ({ type: "text_delta", delta });

async function scenario(options: {
  respond(request: ModelRequest, turn: number): ProviderStreamEvent[];
  tools?: ToolDefinition[];
  budget?: Partial<RunBudget>;
  verification?: Profile["verificationPolicy"];
  parallel?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "harness-convergence-"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  try {
    const requests: ModelRequest[] = [];
    const executions: string[] = [];
    const model = descriptor({ providerId: "fake", modelId: "loop", displayName: "Loop", capabilities: { vision: false, tools: true, parallelTools: options.parallel ?? false, structuredOutput: true, maxContextTokens: 128_000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        requests.push(structuredClone(request));
        if (request.purpose === "compaction") {
          const part = request.messages.find(message => message.role === "user")?.content.find(part => part.type === "text");
          const state = part?.type === "text" ? JSON.parse(part.text).state : undefined;
          const facts = (value: unknown) => (Array.isArray(value) ? value : [value]).map(item => typeof item === "string" ? item : JSON.stringify(item));
          yield { type: "text_delta", delta: JSON.stringify({
            goal: state.goal, constraints: facts(state.constraints), decisions: facts(state.decisions),
            evidence: facts(state.evidence), completed: facts(state.completed), pending: facts(state.pending),
          }) };
          return;
        }
        yield* options.respond(request, requests.length);
      },
    };
    const definitions = options.tools ?? [readTool];
    const tools = new ToolRegistry();
    for (const tool of definitions) tools.register({ ...tool, async execute(input, context) { executions.push(tool.contract.name); return tool.execute(input, context); } });
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: definitions.map((tool) => tool.contract.name), ...(options.verification ? { verificationPolicy: options.verification } : {}) };
    const run: RunSpec = { workflowVersion: 1, id: newId("run"), sessionId: "test", request: "Analyze the repository and identify concrete issues; do not edit", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, ...options.budget }, grants: [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture"], networkDomains: [], maxRisk: "high" }], createdAt: nowIso() };
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolveResult, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("fixture timed out")); }, 8000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "fixture"), 0);
        if (event.type === "result") { clearTimeout(timer); resolveResult(event); }
      });
      engine.start(run, profile);
    });
    await new Promise<void>((done) => setImmediate(done));
    return { result, requests, executions, events: database.listEvents(run.id), checkpoints: database.listCheckpoints(run.id) };
  } finally {
    database.close(); vault.dispose();
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  }
}

describe("agent loop convergence", () => {
  it("propagates unrelated continuation callback failures", async () => {
    const model = descriptor({ providerId: "fake", modelId: "callback-guard", displayName: "Callback guard", maxContextTokens: 16_384 });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream() { yield say("Initial work completed."); },
    };
    const failure = new Error("context_summary_budget_exhausted: unrelated callback failure");
    await expect(runWithPiAgent({
      runId: "callback-guard", sessionId: "callback-guard", provider, model,
      initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: "Inspect the supplied evidence." }] }],
      contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal,
      maxOutputTokens: 100, parallelToolCalls: false,
      beforeToolCall: async () => ({}), executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false,
      onProviderEvent: () => {}, afterAgentRun: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it("delivers action-specific workflow errors through the real bridge and charges the attempted call", async () => {
    const observed = await scenario({ budget: { maxTurns: 4 }, respond: (_request, turn) => turn <= 2 ? workflowPrelude(turn) : turn === 3
      ? [{ type: "tool_call", toolCall: { id: "incomplete-plan", name: "update_workflow", input: { action: "plan", context: "source read", steps: ["small fix"] } } }]
      : [say("Plan fields need correction.")] });
    const messages = JSON.stringify(observed.requests[3]?.messages);
    expect(messages).toContain("workflow_input_invalid");
    expect(messages).toContain("missingFields");
    expect(observed.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_finished", callId: "incomplete-plan", isError: true, output: expect.objectContaining({ missingFields: ["cause", "evidenceIds"] }) })]));
    expect(Math.max(...observed.checkpoints.map(checkpoint => checkpoint.toolCalls))).toBe(3);
  });
  it("continues past three consecutive tool errors", async () => {
    const observed = await scenario({ tools: [{ ...readTool, async execute() { throw new Error("missing fixture"); } }], respond: (_request, turn) => turn <= 4 ? [read(`r${turn}`, `${turn}.ts`)] : [say("Inspected missing files; no changes made.")] });
    expect(observed.executions).toHaveLength(4);
    expect(observed.requests).toHaveLength(5);
    const corrections = observed.events.filter(e => e.type === "self_correction_started");
    expect(corrections).toHaveLength(4);
    expect(corrections.every(e => e.type === "self_correction_started" && e.maxAttempts === null)).toBe(true);
  });
  it("enforces the new 128 tool default even for an oversized batch", async () => {
    const observed = await scenario({ respond: request => request.tools.length ? Array.from({length:129}, (_,i) => read(`r${i}`, `${i}.ts`)) : [say("Tool budget reached.")] });
    expect(observed.executions).toHaveLength(128);
    expect(observed.result.stop).toMatchObject({ code: "tool_call_limit", usage: {toolCalls: {used:128,limit:128}, repairs:{used:0,limit:null}} });
  });
  it("enforces the new 64 model default including the final summary", async () => {
    const observed = await scenario({ respond: (request, turn) => request.tools.length ? [read(`r${turn}`, `${turn}.ts`)] : [say("Remaining work requires another run.")] });
    expect(observed.requests).toHaveLength(64);
    expect(observed.result.stop).toMatchObject({ code: "model_turn_limit", usage: {modelTurns: {used:64,limit:64}} });
  });
  it("reports cost exhaustion without an extra summary model call", async () => {
    const observed = await scenario({ budget: {maxUsd:1}, respond: () => [{type:"usage", usage:{inputTokens:1,outputTokens:1,estimatedUsd:2}}] });
    expect(observed.requests).toHaveLength(1);
    expect(observed.result.stop?.code).toBe("cost_limit");
  });
  it("classifies cost exhaustion during a repair model call", async () => {
    const terminal: ToolDefinition = { ...terminalTool, async execute() { return {output:{exitCode:1,stderr:"fixture failure"},isError:true}; } };
    const observed = await scenario({ tools:[readTool,terminal], budget:{maxUsd:1}, verification:{items:[{id:"check",command:"fixture",cwd:".",timeoutMs:1000,required:true,expectedExitCodes:[0]}],maxRepairAttempts:null}, respond: (_request,turn) => turn <= 3 ? workflowPrelude(turn) : turn === 4 ? [{type:"tool_call",toolCall:{id:"command",name:"terminal",input:{command:"fixture"}}}] : turn === 5 ? [say("The failure needs diagnosis.")] : [{type:"usage",usage:{inputTokens:1,outputTokens:1,estimatedUsd:2}}] });
    expect(observed.events.some(e => e.type === "repair_started")).toBe(true);
    expect(observed.result).toMatchObject({status:"review",stop:{code:"cost_limit"}});
  });
  it("preserves the stop cause when the summary provider fails", async () => {
    const observed = await scenario({ budget:{maxToolCalls:1}, respond: request => { if (!request.tools.length) throw new Error("summary unavailable"); return [read("r1")]; } });
    expect(observed.executions).toHaveLength(1);
    expect(observed.result.stop).toMatchObject({code:"tool_call_limit",summaryError:expect.stringContaining("summary unavailable")});
  });
  it("reports a real shell exit failure without losing process output", async () => {
    const result = await terminalTool.execute({ command: "exit 1" }, { runId: "fixture", workspacePath: tmpdir(), grants: [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["exit 1"], networkDomains: [], maxRisk: "high" }], signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ exitCode: 1, timedOut: false });
  });

  it("allows text-only work with a zero tool budget", async () => {
    const observed = await scenario({ budget: { maxToolCalls: 0, maxTurns: 1 }, respond: () => [say("Answer from the supplied context.")] });
    expect(observed.executions).toHaveLength(0);
    expect(observed.result).toMatchObject({ status: "completed", text: "Answer from the supplied context." });
  });

  it("returns thrown read errors with their actual diagnostic to the next model turn", async () => {
    const observed = await scenario({ tools: [{ ...readTool, async execute() { throw new Error("ENOENT: src/auth.ts does not exist"); } }], respond: (_request, turn) => turn === 1 ? [read("r1")] : [say("Missing file; inspected scope is incomplete.")] });
    expect(JSON.stringify(observed.requests[1]?.messages)).toContain("ENOENT: src/auth.ts does not exist");
    expect(JSON.stringify(observed.requests[1]?.messages)).toContain('"isError":true');
    expect(observed.events.some((event) => event.type === "self_correction_started")).toBe(true);
    expect(observed.checkpoints.some((checkpoint) => checkpoint.reason === "tool_batch" && JSON.stringify(checkpoint.transcript).includes("ENOENT"))).toBe(true);
  });

  it.each([false, true])("caps a batch before execution and summarizes without tools (parallel=%s)", async (parallel) => {
    const observed = await scenario({ parallel, budget: { maxToolCalls: 2 }, respond: (request) => request.tools.length ? [say("Exploring"), read("r1", "a.ts"), read("r2", "b.ts"), read("r3", "c.ts")] : [say("Found a.ts and b.ts; c.ts remains uninspected.")] });
    expect(observed.executions).toHaveLength(2);
    expect(observed.requests).toHaveLength(2);
    expect(observed.requests[1]?.tools).toEqual([]);
    expect(observed.result.status).toBe("review");
    expect(observed.result.text).toContain("Found a.ts and b.ts");
    expect(observed.result.text).not.toContain("Exploring");
    expect(observed.events.some((event) => event.type === "error")).toBe(false);
    expect(Math.max(...observed.checkpoints.map((checkpoint) => checkpoint.toolCalls))).toBe(2);
  });

  it("stops repeated identical reads and preserves a useful summary", async () => {
    const observed = await scenario({ respond: (request, turn) => request.tools.length ? [read(`r${turn}`)] : [say("Read auth.ts; remaining analysis needs a different approach.")] });
    expect(observed.executions).toHaveLength(3);
    expect(observed.requests).toHaveLength(4);
    expect(observed.result).toMatchObject({ status: "review" });
    expect(observed.result.text).toContain("相同结果");
    expect(JSON.stringify(observed.requests[1]?.messages)).toContain("recentObservations");
    expect(JSON.stringify(observed.requests[0]?.messages)).toContain("Runtime environment");
  });

  it("counts structured terminal failures as errors and forwards stdout/stderr", async () => {
    const terminal: ToolDefinition = { ...terminalTool, async execute() { return { output: { exitCode: 1, stdout: "", stderr: "fixture syntax error" }, isError: true }; } };
    const observed = await scenario({ tools: [readTool, terminal], verification: { items: [{ id: "test", command: "fixture", cwd: ".", timeoutMs: 1000, required: true, expectedExitCodes: [0] }], maxRepairAttempts: 1 }, respond: (_request, turn) => turn <= 3 ? workflowPrelude(turn) : turn === 4 ? [{ type: "tool_call", toolCall: { id: "cmd", name: "terminal", input: { command: "fixture" } } }] : [say("The command failed; inspect the syntax error.")] });
    expect(JSON.stringify(observed.requests[4]?.messages)).toContain("fixture syntax error");
    expect(observed.events.some((event) => event.type === "tool_finished" && event.isError === true)).toBe(true);
    expect(observed.events.some((event) => event.type === "self_correction_started")).toBe(true);
  });

  it("never uses an extra model turn after the configured limit", async () => {
    const observed = await scenario({ budget: { maxTurns: 1, maxToolCalls: 1 }, respond: () => [say("I will keep exploring"), read("r1")] });
    expect(observed.requests).toHaveLength(1);
    expect(observed.result.status).toBe("review");
    expect(observed.result.text).toContain("src/auth.ts");
    expect(observed.result.text).not.toContain("I will keep exploring");
  });

  it("cannot execute tools emitted by a provider during tool-free summary", async () => {
    const observed = await scenario({ budget: { maxToolCalls: 1 }, respond: () => [read("r1")] });
    expect(observed.executions).toHaveLength(1);
    expect(observed.requests).toHaveLength(2);
    expect(observed.result.status).toBe("review");
    expect(observed.result.text).toContain("src/auth.ts");
  });

  it("does not bypass maxTurns through verification repair", async () => {
    const terminal: ToolDefinition = { ...terminalTool, async execute() { return { output: { exitCode: 1, stdout: "", stderr: "fixture failed" }, isError: true }; } };
    const observed = await scenario({ tools: [terminal], budget: { maxTurns: 1 }, verification: { items: [{ id: "test", command: "fixture", cwd: ".", timeoutMs: 1000, required: true, expectedExitCodes: [0] }], maxRepairAttempts: 2 }, respond: () => [say("Initial response")] });
    expect(observed.requests).toHaveLength(1);
    expect(observed.executions).toHaveLength(1);
    expect(observed.result.status).toBe("review");
  });

  it("keeps final text separate from earlier progress in engine and UI", async () => {
    const observed = await scenario({ respond: (_request, turn) => turn === 1 ? [say("I will inspect auth.ts"), read("r1")] : [say("The login handler lacks a null check.")] });
    expect(observed.result.text).toBe("The login handler lacks a null check.");
    expect(assistantMessages(observed.events)).toEqual({ text: observed.result.text, progress: ["I will inspect auth.ts"] });
    expect(assistantMessages(observed.events.filter((event) => event.type !== "result")).text).toBe(observed.result.text);
  });
});

describe("read observation invalidation", () => {
  it("allows fresh results and rereads after a possible mutation", () => {
    const progress = new RunProgress();
    const call = { id: "r", name: "read_file", input: { path: "auth.ts" } };
    expect(progress.record(call, readTool, { output: "old" })).toBeUndefined();
    expect(progress.record(call, readTool, { output: "old" })).toBeUndefined();
    expect(progress.record(call, readTool, { output: "new" })).toBeUndefined();
    expect(progress.record(call, readTool, { output: "new" })).toBeUndefined();
    progress.invalidate();
    expect(progress.record(call, readTool, { output: "new" })).toBeUndefined();
  });
});
