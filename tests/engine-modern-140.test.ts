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
  verificationWritesSource?: boolean;
  /** Give the profile a real local check so `verify()` has an item to run. */
  verificationItems?: boolean;
  /** Simulate the storage failure that killed the daemon mid-run: the whole-database export fails once. */
  failVerificationCheckpoint?: boolean;
  /** Pre-authorize the probe tool so the fixture does not have to answer an approval. */
  probeGrant?: boolean;
  /** Answer every interactive request immediately, so a test can count how many were asked for. */
  autoApprove?: boolean;
};

/**
 * The 1.4.0 modern workflow is the production default: RunSpec omits workflowVersion, so
 * `modern` is true and the lightweight tools plus runtime gates are what the model actually sees.
 */
async function analysisRun(
  respond: (request: ModelRequest, turn: number, workspace: string) => ProviderStreamEvent[],
  options: ModernOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harness-modern-140-"));
  // The database and key live outside the workspace, exactly like the shipped app keeps them in the
  // user data directory: otherwise every checkpoint write would look like a repository change.
  const state = await mkdtemp(join(tmpdir(), "harness-modern-140-state-"));
  const vault = await VaultCrypto.open(join(state, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(state, "db.sqlite"), vault);
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
        yield* respond(request, requests.length, root);
      },
    };
    const tools = new ToolRegistry();
    for (const tool of [readFileFixture, terminalFixture]) tools.register({ ...tool, async execute(input, context) { executions.push(tool.contract.name); if (options.verificationWritesSource && tool.contract.name === "terminal") await writeFile(join(root, "memory.ts"), "export const memory = 2;\n"); return tool.execute(input, context); } });
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
      grants: [
        ...(options.verificationItems
          ? [{ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["fixture-verify"], networkDomains: [], maxRisk: "high" as const }]
          : []),
        ...(options.probeGrant
          ? [{ toolNames: ["probe"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "high" as const }]
          : []),
      ],
      createdAt: nowIso(),
      taskMode: options.taskMode ?? "analysis",
    };
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolveResult, reject) => {
      const timer = setTimeout(() => { engine.cancel(run.id); reject(new Error("modern fixture timed out")); }, 10_000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "result") { clearTimeout(timer); resolveResult(event); }
        // Interactive requests are answered immediately when asked for; a test can then assert how
        // many the runtime actually raised.
        if (options.autoApprove && event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "fixture"), 0);
        if (options.autoApprove && event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "fixture"), 0);
      });
      engine.start(run, profile);
    });
    await new Promise<void>((done) => setImmediate(done));
    return { result, requests, executions, workspace: root, events: database.listEvents(run.id), checkpoints: database.listCheckpoints(run.id) };
  } finally {
    database.close(); vault.dispose();
    for (const directory of [root, state]) {
      const rel = relative(tmpdir(), directory);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup target");
      await rm(directory, { recursive: true, force: true });
    }
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
      // The 8192 ceiling is only reachable when the planner asks for it. A 4096 estimate used to be
      // the binding limit, so a long single answer came back truncated (max_output_tokens).
      expect(request.maxOutputTokens).toBe(8_192);
      expect(request.tools.map((tool) => tool.name).sort()).toEqual(["probe", "read_evidence", "read_file", "run_verification", "terminal", "todo"]);
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

  it("runs a permission-checked host probe in auto mode from a scratch directory", async () => {
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("probe-1", "probe", { command: "pwd" })]
      : [say("探针结果已记录；未修改仓库。")],
    { taskMode: "auto", autoApprove: true });

    // The gate admits the probe instead of rejecting it as an arbitrary script.
    const output = observed.requests.map((request) => toolOutput(request, "probe-1")).join("");
    expect(output).toContain("harness-agent-probe");
    expect(output).not.toContain("analysis_mode_read_only");
    // Its artifacts live outside the repository, so the run records a probe, never a write.
    const effects = observed.checkpoints.map((checkpoint) => checkpoint.workflow?.effect);
    expect(effects).toContain("probe");
    expect(effects).not.toContain("repository_write");
    const revisions = observed.checkpoints.map((checkpoint) => checkpoint.workflow?.revision);
    expect(new Set(revisions)).toEqual(new Set([0]));
    expect(observed.result.status).toBe("completed");
  });

  it("asks for one program-scoped probe approval per run instead of one per command", async () => {
    const observed = await analysisRun((_request, turn) => turn === 1
      ? [call("probe-1", "probe", { command: "echo one" })]
      : turn === 2
        ? [call("probe-2", "probe", { command: "echo two" })]
        : [say("两个探针都已记录。")],
    { taskMode: "auto", autoApprove: true });

    // The second probe of the same program reused the run grant: no second interruption.
    expect(observed.events.filter((event) => event.type === "approval_required")).toHaveLength(1);
    for (const id of ["probe-1", "probe-2"]) {
      const result = observed.requests.map((request) => toolOutput(request, id)).join("");
      expect(result).toContain("\"isError\":false");
    }
  });

  it("analysis probes cannot write repository source through host absolute paths", async () => {
    const observed = await analysisRun((_request, turn, workspace) => turn === 1
      ? [call("probe-1", "probe", { command: `echo changed > ${workspace.replaceAll("\\", "/")}/memory.ts` })]
      : turn === 2 ? [call("read", "read_file", { path: "memory.ts" })] : [say("已读取源码；探针未通过，结论有未验证范围。")],
    { taskMode: "analysis", autoApprove: true });
    const revisions = observed.checkpoints.map(checkpoint => checkpoint.workflow?.revision ?? 0);
    expect(Math.max(...revisions)).toBe(0);
    expect(observed.requests.map(request => toolOutput(request, "read")).join("")).toContain("export const memory = 1");
  });
});

it("verification records fingerprints and rejects a command that edits source", async () => {
 const observed = await analysisRun((_request, turn) => turn === 1 ? [call("check", "run_verification", {command:"fixture-verify"})] : [say("验证改变了文件，需要重新检查。")], { taskMode:"auto", verificationItems:true, verificationWritesSource:true });
 const receipt = observed.events.find(e => e.type === "verification_finished");
 expect(receipt?.type === "verification_finished" && receipt.verification.passed).toBe(false);
 if (receipt?.type !== "verification_finished") throw new Error("Missing verification receipt");
 expect(receipt.verification.codeFingerprint).toMatch(/^[a-f0-9]{64}$/);
 expect(receipt.verification.results[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
 expect(receipt.verification.results[0]?.output).toContain("Verification invalidated");
 expect(receipt.verification.revision).toBeGreaterThan(0);
});

it("reuses unchanged file evidence without executing the read again", async () => {
  const observed = await analysisRun((_request, turn) => turn <= 2 ? [call("read-" + turn, "read_file", { path: "memory.ts" })] : [say("analysis complete")]);
  expect(toolOutput(observed.requests[1], "read-1")).toContain("export const memory");
  expect(toolOutput(observed.requests[2], "read-2")).toContain("reusedEvidenceId");
  const timings = observed.events.filter(event => event.type === "model_request_finished");
  expect(timings).toHaveLength(observed.requests.length);
  expect(timings.every(event => event.purpose === "main" && event.succeeded && event.durationMs >= 0)).toBe(true);
});
it("retains different verification commands within the same stage", async () => {
  const observed = await analysisRun((_request, turn) => turn <= 2 ? [call("check-" + turn, "run_verification", { command: "fixture-check-" + turn, stage: "local" })] : [say("checks observed")], { taskMode: "auto", autoApprove: true });
  const latest = observed.events.filter(event => event.type === "verification_finished").at(-1);
  expect(latest?.verification.results.map(result => result.command)).toEqual(["fixture-check-1", "fixture-check-2"]);
});
