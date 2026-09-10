import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec } from "@harness/protocol";
import { ToolRegistry, type ToolDefinition } from "@harness/tools";

const readFileFixture: ToolDefinition = {
  contract: { name: "read_file", description: "fixture read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
  async execute(input) { return { output: `contents of ${String(input.path)}` }; },
};
const terminalFixture: ToolDefinition = {
  contract: { name: "terminal", description: "fixture terminal", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, risk: "high", idempotent: false, timeoutMs: 1000 },
  async execute(input) { return { output: { exitCode: 0, stdout: `ran ${String(input.command)}` }, isError: false }; },
};
const say = (delta: string): ProviderStreamEvent => ({ type: "text_delta", delta });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });

type ModernOptions = {
  taskMode?: RunSpec["taskMode"];
  /** Give the profile a real local check so `verify()` has an item to run. */
  verificationItems?: boolean;
  /** Simulate the storage failure that killed the daemon mid-run: the whole-database export fails once. */
  failVerificationCheckpoint?: boolean;
};

/**
 * The 1.4.0 modern workflow is the production default: RunSpec omits workflowVersion, so
 * `modern` is true and the lightweight tools plus runtime gates are what the model actually sees.
 */
async function analysisRun(
  respond: (request: ModelRequest, turn: number) => ProviderStreamEvent[],
  options: ModernOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harness-modern-140-"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  try {
    if (options.failVerificationCheckpoint) {
      const saveCheckpoint = database.saveCheckpoint.bind(database);
      let failedOnce = false;
      database.saveCheckpoint = (checkpoint: Parameters<typeof saveCheckpoint>[0]) => {
        if (!failedOnce && checkpoint.reason === "verification") {
          failedOnce = true;
          throw new Error("disk full while exporting the database");
        }
        return saveCheckpoint(checkpoint);
      };
    }
    await writeFile(join(root, "memory.ts"), "export const memory = 1;\n");
    const requests: ModelRequest[] = [];
    const executions: string[] = [];
    const model = descriptor({ providerId: "fake", modelId: "modern", displayName: "Modern", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128_000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        requests.push(structuredClone(request));
        yield* respond(request, requests.length);
      },
    };
    const tools = new ToolRegistry();
    for (const tool of [readFileFixture, terminalFixture]) tools.register({ ...tool, async execute(input, context) { executions.push(tool.contract.name); return tool.execute(input, context); } });
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      allowedProviders: ["fake"],
      toolNames: ["read_file", "terminal"],
      ...(options.verificationItems
        ? { verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, items: [{ id: "unit", command: "fixture-verify", cwd: ".", timeoutMs: 1_000, stage: "local" as const, required: true, expectedExitCodes: [0] }] } }
        : {}),
    };
    const run: RunSpec = {
      id: newId("run"),
      sessionId: "modern-140",
      request: "检查 memory 模块并给出优化方案",
      workspacePath: root,
      profileId: profile.id,
      attachments: [],
      budget: profile.budget,
      // A pre-granted terminal keeps the verification's inner call out of the interactive approval flow.
      grants: options.verificationItems
        ? [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture-verify"], networkDomains: [], maxRisk: "high" }]
        : [],
      createdAt: nowIso(),
      taskMode: options.taskMode ?? "analysis",
    };
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolveResult, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("modern fixture timed out")); }, 10_000);
      engine.on("event", (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); resolveResult(event); } });
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

/** The harness tool result part the model actually receives for one call. */
function toolOutput(request: ModelRequest | undefined, toolCallId: string): string {
  const parts = (request?.messages ?? []).flatMap((message) => message.content);
  return JSON.stringify(parts.filter((part) => part.type === "tool_result" && part.toolCallId === toolCallId));
}

describe("1.4.0 modern analysis path end to end", () => {
  it("completes a read-only analysis with no phantom revision and no update_workflow", async () => {
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("read", "read_file", { path: "memory.ts" })]
      : turn === 2
        ? [call("plan", "todo", { items: [{ id: "scope", text: "检查 memory 模块", status: "in_progress" }] })]
        : [say("memory 模块缺少容量上限；未检查检索路径。")]);

    expect(observed.result).toMatchObject({ status: "completed", text: "memory 模块缺少容量上限；未检查检索路径。" });
    // The real paged read tool runs (lightweightTools replaces read_file), so the evidence must exist.
    expect(observed.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_finished", callId: "read" })]));
    expect(observed.events.some((event) => event.type === "tool_finished" && event.callId === "read" && event.isError === true)).toBe(false);
    // The model never sees the legacy large workflow tool, only the lightweight runtime set.
    for (const request of observed.requests) {
      expect(request.tools.map((tool) => tool.name).sort()).toEqual(["read_evidence", "read_file", "run_verification", "terminal", "todo"]);
      for (const tool of request.tools) {
        const schema = tool.inputSchema as { properties?: Record<string, { default?: unknown }>; required?: string[] };
        const defaulted = Object.keys(schema.properties ?? {}).filter(key => schema.properties?.[key]?.default !== undefined);
        expect(defaulted.filter(key => (schema.required ?? []).includes(key))).toEqual([]);
      }
    }
    // A terminal query or any read must never advance the repository revision.
    const revisions = observed.checkpoints.map((checkpoint) => checkpoint.workflow?.revision).filter((revision) => revision !== undefined);
    expect(revisions.length).toBeGreaterThan(0);
    expect(new Set(revisions)).toEqual(new Set([0]));
    expect(observed.checkpoints.at(-1)?.workflow).toMatchObject({ taskMode: "analysis", intent: "analysis", changedFiles: [] });
    expect(observed.events.some((event) => event.type === "verification_started")).toBe(false);
  });

  it("blocks a repository write in analysis mode and still delivers the analysis", async () => {
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("mutate", "terminal", { command: "echo tampered > memory.ts" })]
      : [say("分析完成：未修改任何源码。")]);

    expect(observed.result).toMatchObject({ status: "completed", text: "分析完成：未修改任何源码。" });
    // The blocked command never reached the terminal tool.
    expect(observed.executions).toEqual([]);
    expect(JSON.stringify(observed.requests.at(-1)?.messages)).toContain("analysis_mode_read_only");
    expect(observed.events.some((event) => event.type === "self_correction_started")).toBe(true);
    const revisions = observed.checkpoints.map((checkpoint) => checkpoint.workflow?.revision).filter((revision) => revision !== undefined);
    expect(revisions.length).toBeGreaterThan(0);
    expect(new Set(revisions)).toEqual(new Set([0]));
  });

  it("gates runtime-owned tools by declared risk instead of a name allowlist", async () => {
    // run_verification is runtime-owned and absent from the durable registry. It must still pass the
    // workflow gate: in analysis mode the write-risk tool is blocked before any command can run.
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("verify", "run_verification", { command: "echo verify", stage: "local" })]
      : [say("分析完成；分析模式未运行任何验证命令。")]);

    expect(observed.result).toMatchObject({ status: "completed", text: "分析完成；分析模式未运行任何验证命令。" });
    expect(observed.executions).toEqual([]);
    expect(observed.events.some((event) => event.type === "verification_started" || event.type === "verification_finished")).toBe(false);
    expect(JSON.stringify(observed.requests.at(-1)?.messages)).toContain("analysis_mode_read_only");
    const revisions = observed.checkpoints.map((checkpoint) => checkpoint.workflow?.revision).filter((revision) => revision !== undefined);
    expect(new Set(revisions)).toEqual(new Set([0]));
  });

  it("returns a short diagnostic plus an evidence reference when a tool throws", async () => {
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("missing", "read_file", { path: "does-not-exist.ts" })]
      : turn === 2
        ? [call("recall", "read_evidence", { id: "missing" })]
        : [say("该文件不存在，未能检查其内容。")]);

    expect(observed.result).toMatchObject({ status: "completed", text: "该文件不存在，未能检查其内容。" });
    // A thrown tool failure must still be recorded as an errored call.
    expect(observed.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_finished", callId: "missing", isError: true })]));
    // The model receives a retrievable reference and the short diagnostic, never full run state.
    const failure = toolOutput(observed.requests.at(-1), "missing");
    expect(failure).toContain("evidenceId");
    expect(failure).toContain("missing");
    expect(failure).toMatch(/no such file|ENOENT/i);
    expect(failure).not.toContain("workingMemory");
    // read_evidence resolves that reference back to the original failure output.
    expect(toolOutput(observed.requests.at(-1), "recall")).toMatch(/no such file|ENOENT/i);
  });

  it("always finishes a verification the runtime aborts, instead of leaving the check pending", async () => {
    // Live 1.4.0-beta.1 evidence: the daemon died while exporting the whole database during a
    // verification. `verification_started` had no matching `verification_finished`, localCheck kept
    // its default `pending` for the rest of the run, and the model reported a harness-level
    // "running" state it then worked around with raw terminal calls.
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("read", "read_file", { path: "memory.ts" })]
      : turn === 2
        ? [call("verify", "run_verification", { command: "fixture-verify", cwd: ".", timeoutMs: 1000, stage: "local" })]
        : [say("验证因运行时存储故障未能完成。")],
    { taskMode: "auto", verificationItems: true, failVerificationCheckpoint: true });

    const started = observed.events.filter((event) => event.type === "verification_started");
    const finished = observed.events.filter((event) => event.type === "verification_finished");
    expect(started.length).toBeGreaterThan(0);
    // Every started verification must reach a terminal record, whatever the failure.
    expect(finished).toHaveLength(started.length);
    const failure = finished.at(-1)?.verification;
    expect(failure).toMatchObject({ outcome: "failed", id: started.at(-1)?.verificationRunId });
    expect(failure?.skipReason).toContain("verification_runtime_error");
    expect(failure?.results[0]?.output).toContain("disk full");
    // A read-only task keeps `localCheck` pending on purpose (a failed probe is not a failed code
    // check); the workflow moves to inspect_result so the model explains the unverified scope
    // instead of waiting for a check that will never arrive.
    expect(observed.checkpoints.some((checkpoint) => checkpoint.workflow?.phase === "inspect_result")).toBe(true);
    // And the model still receives the short structured failure plus a retrievable reference.
    const failureOutput = observed.requests.map((request) => toolOutput(request, "verify")).join("");
    expect(failureOutput).toContain("evidenceId");
    expect(failureOutput).toContain("disk full");
    expect(failureOutput).not.toContain("workingMemory");
    // The run reaches a result instead of hanging in a harness-level "running" state.
    expect(observed.result.status).toBe("completed");
  });
});
