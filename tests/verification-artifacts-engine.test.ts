import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { AgentEventSchema, DEFAULT_PROFILE, newId, nowIso, VerificationItemSchema, type AgentEvent, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { createDefaultToolRegistry, terminalTool, ToolRegistry } from "@harness/tools";
import { verificationItemFingerprint } from "../packages/core/src/durable-recovery.js";
import { snapshotWorkspace, workspaceFingerprint } from "../packages/core/src/workspace-impact.js";

type Mode = "declared" | "undeclared" | "source-change" | "overwrite" | "contract-mismatch";
const command = "node --test capture.test.mjs";
const artifactPath = "screenshots/dashboard.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });

async function scenario(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "harness-verification-artifacts-engine-"));
  const workspace = join(root, "repo");
  await mkdir(workspace);
  await writeFile(join(workspace, "app.mjs"), "export const value = 0;\n");
  await writeFile(join(workspace, "capture.test.mjs"), "import test from 'node:test'; test('capture fixture', () => {});\n");
  if (mode === "overwrite") {
    await mkdir(join(workspace, "screenshots"));
    await writeFile(join(workspace, artifactPath), png);
  }
  const vault = await VaultCrypto.open(join(root, "key.json"), "verification-artifacts-engine-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const executions: string[] = [];
  let latest: WorkflowState | undefined;
  let phase = "prepare";
  const check = { command, cwd: ".", timeoutMs: 10_000, ...(mode === "undeclared" ? {} : { generatedArtifactPaths: [artifactPath] }) };
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register({ contract: { name: "implement_dashboard", description: "Fixture dashboard source edit", inputSchema: { type: "object", properties: {} }, risk: "write", idempotent: false, timeoutMs: 1000 },
    async execute() { await writeFile(join(workspace, "app.mjs"), "export const value = 1;\n"); return { output: { updated: "app.mjs" } }; } });
  tools.register({ ...terminalTool, async execute(input) {
    executions.push(String(input.command));
    await mkdir(join(workspace, "screenshots"), { recursive: true });
    await writeFile(join(workspace, artifactPath), mode === "overwrite" ? Buffer.concat([png, Buffer.from("changed")]) : png);
    if (mode === "source-change") await writeFile(join(workspace, "app.mjs"), "export const value = 2;\n");
    return { output: { exitCode: 0, stdout: "Capture fixture wrote screenshots/dashboard.png", stderr: "", truncated: false, timedOut: false } };
  } });
  const model = descriptor({ providerId: "fake", modelId: "verification-artifacts", displayName: "Verification artifacts fixture", capabilities: {
    vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local",
  } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      if (request.purpose === "review") throw new Error("Independent model review must remain disabled");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) { yield { type: "text_delta", delta: "Verification fixture stopped." }; return; }
      if (phase === "prepare") {
        yield call("read-source", "read_file", { path: "app.mjs" });
        yield call("read-capture", "read_file", { path: "capture.test.mjs" });
        yield call("configure", "advance_workflow", {
          action: "configure", summary: "Implement a dashboard value and save its capture", requirements: ["Dashboard implementation is checked and the capture is delivered"],
          architecture: "One module and a persisted capture test entry", evidenceIds: ["read-source", "read-capture"],
          steps: [{ id: "dashboard", text: "Implement dashboard and capture it", verification: [check] }], integration: [check],
        });
        yield call("select-dashboard", "advance_workflow", { action: "select_next" });
        phase = "implement"; return;
      }
      if (phase === "implement") {
        yield call("implement", "implement_dashboard", {});
        phase = "verify"; return;
      }
      if (phase === "verify") {
        yield call("verify-local", "run_verification", { ...check, ...(mode === "contract-mismatch" ? { generatedArtifactPaths: ["screenshots/other.png"] } : {}) });
        phase = "integration"; return;
      }
      if (phase === "integration") {
        if (mode !== "declared") { engine.cancel(request.runId); return; }
        yield call("verify-broader", "run_verification", { ...check, stage: "broader" });
        phase = "diff"; return;
      }
      if (phase === "diff") { yield call("current-diff", "workspace_diff", {}); phase = "accept"; return; }
      if (phase === "accept") {
        if (!latest) throw new Error("Workflow state is required");
        yield call("accept-requirements", "check_requirements", { evidence: latest.requirementIds.map(requirementId => ({
          requirementId, passed: true, summary: "The current complete diff and passing capture receipts cover the implementation and delivered image",
          observationIds: ["current-diff"], diffObservationId: "current-diff", verificationIds: [latest!.localCheck.runId, latest!.broaderCheck.runId],
        })) });
        phase = "report"; return;
      }
      yield { type: "text_delta", delta: "The dashboard capture is delivered and the current complete diff and requirements are accepted." };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database),
    skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "implement_dashboard", "terminal"], memoryScopes: [],
    verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled" } };
  const spec: RunSpec = { id: newId("run"), sessionId: "verification-artifacts", request: "Implement dashboard and save a verified screenshot",
    workspacePath: workspace, taskMode: "auto", profileId: profile.id, attachments: [], grants: [], createdAt: nowIso(),
    budget: { ...profile.budget, maxTurns: 12, maxToolCalls: 30 } };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "workflow_updated") latest = structuredClone(event.workflow);
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
  });
  try {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error(`Artifact ${mode} scenario timed out`)); }, 20_000);
      engine.on("event", (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); resolve(event); } });
      engine.start(spec, profile);
    });
    await engine.waitForSettlement(spec.id);
    const runs = database.listVerificationRuns(spec.id);
    const fingerprint = workspaceFingerprint(await snapshotWorkspace(workspace));
    const receiptItem = runs[0]?.results[0];
    const expectedItemFingerprint = receiptItem ? verificationItemFingerprint(fingerprint, VerificationItemSchema.parse({ ...check, id: receiptItem.itemId, stage: "local" }), workspace) : undefined;
    return { result, events, executions, latest, runs, fingerprint, expectedItemFingerprint, image: await readFile(join(workspace, artifactPath)).catch(() => undefined), source: await readFile(join(workspace, "app.mjs"), "utf8") };
  } finally {
    await engine.close(); database.close(); vault.dispose();
    const name = relative(tmpdir(), root);
    if (!name || name.startsWith("..") || isAbsolute(name)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("generated screenshot artifacts through the actual verification engine", { timeout: 30_000 }, () => {
  it("accepts a declared new screenshot, binds receipts to the post-check workspace and completes current diff acceptance", async () => {
    const f = await scenario("declared");
    expect(f.result.status, JSON.stringify(f.result)).toBe("completed");
    expect(f.executions).toEqual([command]);
    expect(f.image).toEqual(png);
    expect(f.source).toContain("= 1;");
    const local = f.runs.find(run => run.stage === "local")!;
    expect(local).toMatchObject({ passed: true, codeFingerprint: f.fingerprint });
    expect(local.results[0]).toMatchObject({ passed: true, exitCode: 0, generatedArtifactPaths: [artifactPath], fingerprint: f.expectedItemFingerprint });
    expect(f.latest).toMatchObject({ requirementsRevision: f.latest!.revision, diffRevision: f.latest!.revision, localCheck: { status: "passed" }, broaderCheck: { status: "passed" } });
    expect(f.events.find(event => event.type === "tool_finished" && event.callId === "current-diff")).toMatchObject({ output: {
      complete: true, files: expect.arrayContaining([expect.objectContaining({ path: "app.mjs", complete: true }), expect.objectContaining({ path: artifactPath, status: "added", complete: true })]),
    } });
    expect(f.events.find(event => event.type === "tool_finished" && event.callId === "accept-requirements")).toMatchObject({ isError: false });
    const finished = f.events.find(event => event.type === "verification_finished")!;
    expect(AgentEventSchema.parse(finished)).toEqual(finished);
  });

  it.each(["undeclared", "source-change", "overwrite"] as const)("invalidates exit-zero verification for %s", async mode => {
    const f = await scenario(mode);
    expect(f.executions).toEqual([command]);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ passed: false, results: [{ exitCode: 0, passed: false, output: expect.stringContaining("Verification invalidated") }] });
    expect(f.latest?.localCheck.status).not.toBe("passed");
    expect(f.result.status).not.toBe("completed");
    if (mode === "source-change") expect(f.source).toContain("= 2;");
  });

  it("rejects a generated-output declaration that differs from the persisted plan before terminal execution", async () => {
    const f = await scenario("contract-mismatch");
    expect(f.executions).toEqual([]);
    expect(f.runs).toEqual([]);
    expect(f.image).toBeUndefined();
    expect(f.events.find(event => event.type === "tool_finished" && event.callId === "verify-local")).toMatchObject({ isError: true, output: {
      code: "verification_not_planned", mismatch: ["generatedArtifactPaths"], expected: [expect.objectContaining({ generatedArtifactPaths: [artifactPath] })],
    } });
  });
});
