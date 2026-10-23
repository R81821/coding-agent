import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { AgentEventSchema, DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { ToolRegistry, createDefaultToolRegistry, terminalTool } from "@harness/tools";

type Mode = "consult" | "read-shell" | "test-command" | "write-shell" | "denied-write" | "doc" | "timeout" | "analysis-write";
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const command = "node --test value.test.mjs";

async function scenario(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "harness-behavior-engine-"));
  const workspace = join(root, "repo"); await mkdir(workspace);
  await writeFile(join(workspace, "value.mjs"), "export const value = 0;\n");
  await writeFile(join(workspace, "value.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./value.mjs"; test("value", () => assert.equal(value, 1));\n');
  const vault = await VaultCrypto.open(join(root, "key.json"), "behavior-test-password");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  const events: AgentEvent[] = [], requests: ModelRequest[] = [], executions: string[] = [];
  let workflow: WorkflowState | undefined;
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register({ ...terminalTool, async execute(input, context) {
    const value = String(input.command); executions.push(value);
    if (value === "inspect") return { output: { stdout: await readFile(join(workspace, "value.mjs"), "utf8"), exitCode: 0 } };
    if (value === "timeout") return { isError: true, output: { stdout: "interrupted", exitCode: null, timedOut: true } };
    if (value === "write") { await writeFile(join(workspace, "value.mjs"), "export const value = 1;\n"); return { output: { stdout: "written", exitCode: 0 } }; }
    if (value === "document") { await writeFile(join(workspace, "design.md"), "# Design\n\nUse a pre-rendered room and semantic UI events.\n"); return { output: { stdout: "written", exitCode: 0 } }; }
    return terminalTool.execute(input, context);
  } });
  const model = descriptor({ providerId: "fake", modelId: "behavior", displayName: "Behavior", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  let phase = 0;
  const provider: ModelProvider = { id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model], async *stream(request) {
    requests.push(structuredClone(request));
    if (request.messages.some(message => message.runtimePrompt === "stop_summary")) { yield { type: "text_delta", delta: "Execution remains unconfirmed." }; return; }
    phase++;
    if (phase === 1 && mode !== "consult") {
      if (mode === "test-command") yield call("test", "run_verification", { command });
      else yield call("operation", "terminal", { command: mode === "read-shell" ? "inspect" : mode === "doc" ? "document" : mode === "timeout" ? "timeout" : "write" });
      return;
    }
    if (mode === "write-shell" && phase === 2) { yield call("verify", "run_verification", { command }); return; }
    if (mode === "doc" && phase === 2 || mode === "write-shell" && phase === 3) { yield call("diff", "workspace_diff", {}); return; }
    if (mode === "doc" && phase === 3 || mode === "write-shell" && phase === 4) {
      yield call("accept", "check_requirements", { evidence: workflow!.requirementIds.map(requirementId => ({ requirementId, passed: true, summary: "Requested output reviewed against current diff and applicable checks", observationIds: ["diff"], diffObservationId: "diff", verificationIds: mode === "doc" ? [] : [workflow!.localCheck.runId] })) }); return;
    }
    yield { type: "text_delta", delta: mode === "consult" ? "推荐预渲染房间与 HTML 界面组合；取舍取决于是否需要自由视角。" : "Report the observed result and relevant limitations." };
  } };
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "terminal"], memoryScopes: [] };
  const spec: RunSpec = { id: newId("run"), sessionId: "behavior", request: mode === "consult" ? "分析这类仪表盘如何实现，不修改当前项目" : `Fixture ${mode}`, taskMode: mode === "analysis-write" ? "analysis" : "auto", profileId: profile.id, workspacePath: workspace, attachments: [], grants: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 8, maxToolCalls: 25 } };
  engine.on("event", (event: AgentEvent) => {
    events.push(event); if (event.type === "workflow_updated") workflow = structuredClone(event.workflow);
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, mode !== "denied-write", "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, mode !== "denied-write", "test:user"), 0);
  });
  try {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Scenario timed out")); }, 20000);
      engine.on("event", (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); resolve(event); } }); engine.start(spec, profile);
    });
    await engine.waitForSettlement(spec.id);
    return { result, requests, executions, workflow, events, source: await readFile(join(workspace, "value.mjs"), "utf8") };
  } finally {
    await engine.close(); database.close(); vault.dispose();
    const child = relative(tmpdir(), root); if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("behavior policy 2 through engine permission/effect/acceptance paths", { timeout: 30000 }, () => {
  it("answers consultation without tools or forced repository gates", async () => {
    const f = await scenario("consult"); expect(f.result.status).toBe("completed"); expect(f.executions).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]!.messages)).not.toContain("projectBaseSnapshot");
    expect(f.requests[0]!.messages.some(message => message.role === "developer")).toBe(true);
    const timing = f.events.find(event => event.type === "model_request_finished");
    expect(timing).toMatchObject({ requestDiagnostic: { modelId: "behavior", boundary: "provider_request" } });
    expect(AgentEventSchema.parse(timing)).toEqual(timing);
  });
  it("runs an authorized readonly terminal inspection without adding test obligations", async () => {
    const f = await scenario("read-shell"); expect(f.result.status).toBe("completed"); expect(f.executions).toEqual(["inspect"]);
    expect(f.events.some(event => event.type === "approval_required")).toBe(true);
    expect(f.events.some(event => event.type === "verification_started")).toBe(false);
  });
  it("reports an explicitly requested failing test without requiring an implementation graph", async () => {
    const f = await scenario("test-command"); expect(f.result.status).toBe("completed"); expect(f.executions).toEqual([command]);
    expect(f.events.find(event => event.type === "verification_finished")).toMatchObject({ verification: { passed: false } });
  });
  it("accepts a real small shell edit only after actual tests and current diff", async () => {
    const f = await scenario("write-shell"); expect(f.result.status, JSON.stringify(f.result)).toBe("completed");
    expect(f.executions).toEqual(["write", command]); expect(f.source).toContain("= 1;");
    expect(f.workflow?.sequential?.steps).toEqual([]); expect(f.workflow?.localCheck.status).toBe("passed");
  });
  it("accepts reviewed plain documentation without unrelated source tests", async () => {
    const f = await scenario("doc"); expect(f.result.status, JSON.stringify(f.result)).toBe("completed"); expect(f.executions).toEqual(["document"]);
    expect(f.workflow?.requirementReceipts[0]?.verificationIds).toEqual([]);
  });
  it("does not execute a denied write or an analysis-mode shell mutation", async () => {
    for (const mode of ["denied-write", "analysis-write"] as const) {
      const f = await scenario(mode); expect(f.executions).toEqual([]); expect(f.source).toContain("= 0;");
    }
  });
  it("does not complete after a timed-out command solely because no file diff was observed", async () => {
    const f = await scenario("timeout"); expect(f.result.status).not.toBe("completed"); expect(f.workflow?.effect).toBe("unknown");
  });
});
