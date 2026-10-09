import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { McpService, McpStore, MemoryService, SkillService } from "@harness/extensions";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunCheckpoint, type RunSpec, type WorkflowState } from "@harness/protocol";
import { applyPatchTool, createDefaultToolRegistry, terminalTool, ToolRegistry } from "@harness/tools";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const localCommand = "node --test test/local.test.mjs";
const integrationCommand = "node --test test/integration.test.mjs";
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 10000 });
const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const requirements = ["Rain remains visible without obscuring the scene", "Animation preserves the existing 60 fps cadence"];
const steps = [{ id: "rain", text: "Improve rain contrast while preserving frame timing", verification: [check(localCommand)] }];
const originalSource = "export const rainOpacity = 0.15;\nexport const frameRate = 60;\n";
const malformedPatch = "--- a/rain.mjs\n+++ b/rain.mjs\n@@ malformed @@\n-export const rainOpacity = 0.15;\n+export const rainOpacity = 0.35;\n export const frameRate = 60;\n";
// Models sometimes calculate counts incorrectly; actual source/context still identify the change.
const correctedPatch = "--- a/rain.mjs\n+++ b/rain.mjs\n@@ -1,3 +1,3 @@\n-export const rainOpacity = 0.15;\n+export const rainOpacity = 0.35;\n export const frameRate = 60;\n";
const finalBody = "Rain contrast is improved. Local and integration test files pass, and the original animation cadence is preserved.";
const cleanup: Array<() => Promise<void>> = [];
const mcpServerFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { pauseAfter?: "patch" | "local" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-repair-resume-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "rain.mjs"), originalSource);
  await writeFile(join(workspace, "test", "local.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { rainOpacity } from "../rain.mjs";',
    'test("rain is legible without hiding the scene", () => {',
    '  assert.equal(rainOpacity, 0.35);',
    '  assert.ok(rainOpacity > 0.2 && rainOpacity < 0.5);',
    '});',
  ].join("\n"));
  await writeFile(join(workspace, "test", "integration.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { rainOpacity, frameRate } from "../rain.mjs";',
    'test("rain contrast and frame cadence compose correctly", () => {',
    '  assert.equal(frameRate, 60);',
    '  assert.equal(rainOpacity * frameRate, 21);',
    '});',
  ].join("\n"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "repair-resume-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const mcp = new McpService(new McpStore(database));
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const patchInputs: string[] = [];
  const commands: string[] = [];
  let latest: WorkflowState | undefined;
  let phase: "prepare" | "malformed" | "correct" | "local" | "integration" | "diff" | "accept" | "report" = "prepare";
  let reprepare = false;
  let paused = false;
  const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
  tools.register({ ...applyPatchTool, async execute(input, context) {
    patchInputs.push(String(input.patch));
    return applyPatchTool.execute(input, context);
  } });
  tools.register({ ...terminalTool, async execute(input, context) {
    commands.push(String(input.command));
    return terminalTool.execute(input, context);
  } });
  const model = descriptor({ providerId: "fake", modelId: "repair-resume", displayName: "Repair resume fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "review") throw new Error("Independent model reviews must not run");
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "Test evidence is incomplete." }; return;
      }
      if (reprepare) {
        reprepare = false;
        // Recovery correctly invalidates old epochs. It must preserve the original requirements/plan.
        yield call("resume-context", "read_file", { path: "rain.mjs" });
        yield action("resume-architecture", { action: "architecture", summary: "Rechecked rain contrast and fixed frame timing", evidenceIds: ["resume-context"] });
        yield action("resume-step", { action: "start_step", stepId: "rain" });
        return;
      }
      if (phase === "prepare") {
        // Useful source evidence can precede the model's formal understand call in the same epoch.
        yield call("original-context", "read_file", { path: "rain.mjs" });
        yield action("understand", { action: "understand", summary: "Improve rain visibility while preserving cadence", requirements });
        yield action("architecture", { action: "architecture", summary: "rain.mjs exposes rain contrast and the frame cadence", evidenceIds: ["original-context"] });
        yield action("plan", { action: "plan", steps, integration: [check(integrationCommand)] });
        yield action("start", { action: "start_step", stepId: "rain" });
        phase = "malformed"; return;
      }
      if (phase === "malformed") {
        yield call("malformed-patch", "patch", { patch: malformedPatch });
        phase = "correct"; return;
      }
      if (phase === "correct") {
        // A generic error previously caused a costly context refresh. A format diagnostic directs
        // the model to repair syntax using the already-read, unchanged source instead.
        if (!JSON.stringify(request.messages).includes("correct_patch")) yield call("unnecessary-refresh", "read_file", { path: "rain.mjs" });
        yield call("corrected-patch", "patch", { patch: correctedPatch });
        phase = "local"; return;
      }
      if (phase === "local") { yield call("local-suite", "run_verification", check(localCommand)); phase = "integration"; return; }
      if (phase === "integration") { yield call("integration-suite", "run_verification", { ...check(integrationCommand), stage: "broader" }); phase = "diff"; return; }
      if (phase === "diff") { yield call("current-diff", "workspace_diff", {}); phase = "accept"; return; }
      if (phase === "accept") {
        if (!latest) throw new Error("The runtime must publish workflow state before acceptance");
        yield call("requirements", "check_requirements", { evidence: latest.requirementIds.map(requirementId => ({
          requirementId, summary: "Rain contrast and frame cadence are covered by the passing local and integration suites",
          observationIds: ["current-diff"], verificationIds: [latest!.localCheck.runId, latest!.broaderCheck.runId], diffObservationId: "current-diff", passed: true,
        })) });
        phase = "report"; return;
      }
      yield { type: "text_delta", delta: finalBody };
    },
  };
  const engine = new HarnessEngine({ database, mcp, blobs: new EncryptedBlobStore(join(root, "blobs"), vault), providers: [provider], tools,
    memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(async () => {
    await engine.close(); await mcp.close(); database.close(); vault.dispose();
    const confined = relative(tmpdir(), root);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "apply_patch", "terminal"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled" } };
  const spec: RunSpec = { id: newId("run"), sessionId: "repair-resume", request: "Improve rain contrast and preserve animation cadence", workspacePath: workspace,
    profileId: profile.id, attachments: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 24, maxToolCalls: 64 }, grants: [] };
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "workflow_updated") latest = event.workflow;
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
    const pauseAtPatch = options.pauseAfter === "patch" && event.type === "tool_finished" && event.callId === "corrected-patch" && !event.isError;
    const pauseAtLocal = options.pauseAfter === "local" && event.type === "verification_finished" && event.verification.stage === "local" && event.verification.passed;
    if (!paused && (pauseAtPatch || pauseAtLocal)) {
      paused = true; engine.pause(spec.id);
    }
  });
  async function run(start: () => void) {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Repair/resume scenario timed out")); }, 20000);
      const onEvent = (event: AgentEvent) => {
        if (event.type !== "result") return;
        clearTimeout(timer); engine.off("event", onEvent); resolve(event);
      };
      engine.on("event", onEvent); start();
    });
    await engine.waitForSettlement(spec.id);
    return result;
  }
  return { engine, database, mcp, spec, profile, events, requests, patchInputs, commands, workspace, run,
    latest: () => latest, resumeContext: (restartLocal = false) => { reprepare = true; if (restartLocal) phase = "local"; } };
}

describe("real patch repair and startup recovery regressions", { timeout: 30000 }, () => {
  it("repairs patch format using the original source, runs test files, and streams the accepted final body once", async () => {
    const f = await fixture();
    const result = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(result.status, JSON.stringify({ text: result.text, stop: result.stop, workflow: f.latest() })).toBe("completed");
    const reads = f.events.filter(event => event.type === "tool_started" && event.call.name === "read_file");
    expect(reads.map(event => event.type === "tool_started" && event.call.id)).toEqual(["original-context"]);
    expect(f.patchInputs).toEqual([malformedPatch, correctedPatch]);
    const malformed = f.events.find(event => event.type === "tool_finished" && event.callId === "malformed-patch");
    expect(malformed).toMatchObject({ isError: true, output: { diagnostic: { kind: "format", paths: ["rain.mjs"], retry: "correct_patch" } } });
    expect(f.events.find(event => event.type === "tool_finished" && event.callId === "corrected-patch")).toMatchObject({ isError: false });
    expect((await readFile(join(f.workspace, "rain.mjs"), "utf8")).replaceAll("\r\n", "\n")).toBe(originalSource.replace("0.15", "0.35"));
    expect(f.latest()?.revision).toBe(1);
    expect(f.latest()?.changedFiles).toEqual(["rain.mjs"]);
    expect(f.commands).toEqual([localCommand, integrationCommand]);
    const verifications = f.database.listVerificationRuns(f.spec.id);
    expect(verifications.map(item => item.stage).sort()).toEqual(["broader", "local"]);
    expect(f.events.flatMap(event => event.type === "verification_finished" ? [event.verification.stage] : [])).toEqual(["local", "broader"]);
    expect(verifications.every(item => item.passed && item.results.length > 0 && item.results.every(result => result.exitCode === 0 && result.passed && !result.timedOut))).toBe(true);
    expect(f.latest()?.requirements).toEqual(requirements);
    expect(f.latest()?.requirementReceipts).toHaveLength(requirements.length);
    expect(f.latest()?.requirementsRevision).toBe(f.latest()?.revision);
    expect(f.latest()?.independentReview.status).toBe("skipped");
    expect(f.requests.some(request => request.purpose === "review")).toBe(false);
    expect(f.events.filter(event => event.type === "text_delta" && event.delta === finalBody)).toHaveLength(1);
    expect(f.events.filter(event => event.type === "result")).toHaveLength(1);
    expect(f.events.find(event => event.sequence === result.sourceAssistantTurnSequence)?.type).toBe("assistant_turn_started");
  });

  it("keeps workflow, baseline, fingerprint and unknown writes through an MCP startup failure before a second resume", async () => {
    const f = await fixture({ pauseAfter: "patch" });
    const paused = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(paused.status, paused.text).toBe("paused");
    const first = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(first.workflow?.requirements).toEqual(requirements);
    expect(first.workflow?.revision).toBe(1);
    expect(first.workflow?.sequential?.steps[0]?.id).toBe("rain");
    expect(first.workspaceBaseline).toBeDefined();
    expect(first.workspaceFingerprint).toBeTruthy();
    const unknownWrite = { id: "unknown-write-before-restart", name: "patch", input: { patch: correctedPatch } };
    const interrupted: RunCheckpoint = { ...first, id: newId("checkpoint"), sequence: first.sequence + 1,
      pendingNonIdempotentToolCalls: [unknownWrite], createdAt: nowIso() };
    f.database.saveCheckpoint(interrupted);
    const modelRequestsBeforeFailure = f.requests.length;
    const failingCatalogRead = vi.spyOn(f.mcp.store, "list").mockImplementationOnce(() => { throw new Error("MCP catalog database temporarily unavailable"); });
    const failed = await f.run(() => f.engine.resume(f.spec.id, f.profile));
    expect(failed.status).toBe("failed");
    expect(failed.text).toContain("MCP catalog database temporarily unavailable");
    expect(f.requests).toHaveLength(modelRequestsBeforeFailure);
    const saved = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(saved.id).not.toBe(interrupted.id);
    expect(saved.workflow).toEqual(interrupted.workflow);
    expect(saved.workspaceBaseline).toEqual(interrupted.workspaceBaseline);
    expect(saved.workspaceFingerprint).toBe(interrupted.workspaceFingerprint);
    expect(saved.pendingNonIdempotentToolCalls).toEqual([unknownWrite]);
    expect(saved.planVersion).toBe(interrupted.planVersion);
    failingCatalogRead.mockRestore();
    f.resumeContext();
    const completed = await f.run(() => f.engine.resume(f.spec.id, f.profile));
    expect(completed.status, JSON.stringify({ text: completed.text, stop: completed.stop, workflow: f.latest() })).toBe("completed");
    expect(f.latest()?.requirements).toEqual(requirements);
    expect(f.latest()?.requirementIds).toEqual(interrupted.workflow?.requirementIds);
    expect(f.latest()?.sequential?.steps.map(step => step.id)).toEqual(["rain"]);
    expect(f.latest()?.revision).toBe(interrupted.workflow?.revision);
    expect(f.latest()?.epoch).not.toBe(interrupted.workflow?.epoch);
    expect(f.latest()?.localCheck.epoch).toBe(f.latest()?.epoch);
    expect(f.latest()?.broaderCheck.epoch).toBe(f.latest()?.epoch);
    expect(f.patchInputs).toEqual([malformedPatch, correctedPatch]);
    expect(f.events.some(event => event.type === "tool_started" && event.call.id === unknownWrite.id)).toBe(false);
    expect(f.requests.slice(modelRequestsBeforeFailure).some(request => JSON.stringify(request.messages).includes("not replayed"))).toBe(true);
    expect(f.commands).toEqual([localCommand, integrationCommand]);
    expect(f.latest()?.requirementReceipts).toHaveLength(requirements.length);
    expect(f.events.filter(event => event.type === "text_delta" && event.delta === finalBody)).toHaveLength(1);
  });

  it("reuses the same-run architecture and real local test receipt when the complete workspace fingerprint is unchanged", async () => {
    const f = await fixture({ pauseAfter: "local" });
    const paused = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(paused.status, paused.text).toBe("paused");
    const checkpoint = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(checkpoint.workflow?.localCheck.status).toBe("passed");
    expect(checkpoint.pendingNonIdempotentToolCalls).toEqual([]);
    expect(checkpoint.workspaceFingerprint).toBeTruthy();
    expect(checkpoint.workflow?.sequential?.steps[0]?.status).toBe("verified");
    const completed = await f.run(() => f.engine.resume(f.spec.id, f.profile));
    expect(completed.status, JSON.stringify({ text: completed.text, stop: completed.stop, workflow: f.latest() })).toBe("completed");
    expect(f.latest()?.epoch).toBe(checkpoint.workflow?.epoch);
    expect(f.latest()?.sequential?.architectureEpoch).toBe(checkpoint.workflow?.sequential?.architectureEpoch);
    expect(f.latest()?.sequential?.evidenceIds).toEqual(["original-context"]);
    expect(f.latest()?.localCheck.runId).toBe(checkpoint.workflow?.localCheck.runId);
    expect(f.events.filter(event => event.type === "tool_started" && event.call.name === "read_file")).toHaveLength(1);
    expect(f.commands).toEqual([localCommand, integrationCommand]);
    expect(f.database.listVerificationRuns(f.spec.id)).toHaveLength(2);
    expect(f.latest()?.requirementReceipts).toHaveLength(requirements.length);
  });

  it("invalidates old local receipts after a workspace fingerprint change and completes with fresh context and test runs", async () => {
    const f = await fixture({ pauseAfter: "local" });
    const paused = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(paused.status, paused.text).toBe("paused");
    const checkpoint = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(checkpoint.workflow?.localCheck.status).toBe("passed");
    await writeFile(join(f.workspace, "rain.mjs"), (await readFile(join(f.workspace, "rain.mjs"), "utf8")) + "\n// External edit while the task was paused.\n");
    const eventsBeforeResume = f.events.length;
    f.resumeContext(true);
    const completed = await f.run(() => f.engine.resume(f.spec.id, f.profile));
    expect(completed.status, JSON.stringify({ text: completed.text, stop: completed.stop, workflow: f.latest() })).toBe("completed");
    expect(f.latest()?.epoch).not.toBe(checkpoint.workflow?.epoch);
    expect(f.latest()?.localCheck.runId).not.toBe(checkpoint.workflow?.localCheck.runId);
    expect(f.latest()?.localCheck.epoch).toBe(f.latest()?.epoch);
    expect(f.events.slice(eventsBeforeResume).some(event => event.type === "workflow_updated" && event.workflow.localCheck.status === "pending")).toBe(true);
    expect(f.events.slice(eventsBeforeResume).filter(event => event.type === "tool_started" && event.call.name === "read_file").map(event => event.type === "tool_started" && event.call.id)).toEqual(["resume-context"]);
    expect(f.commands).toEqual([localCommand, localCommand, integrationCommand]);
    expect(f.latest()?.requirementReceipts.every(receipt => !receipt.verificationIds.includes(checkpoint.workflow!.localCheck.runId))).toBe(true);
  });

  it.each(["legacy_hash", "remote_schema"] as const)("quarantines %s MCP drift on resume and delivers untrusted diagnostics while local work completes", async drift => {
    const f = await fixture({ pauseAfter: "patch" });
    const server = await f.mcp.save({ name: "Resume project service", transport: { type: "stdio", command: process.execPath, args: [mcpServerFile] },
      enabled: true, projectPaths: [f.workspace], readOnlyTools: ["echo"] });
    const paused = await f.run(() => f.engine.start(f.spec, f.profile));
    expect(paused.status, paused.text).toBe("paused");
    const checkpoint = f.database.getLatestCheckpoint(f.spec.id)!;
    expect(checkpoint.workflow?.requirements).toEqual(requirements);
    expect(checkpoint.workflow?.sequential?.steps[0]?.id).toBe("rain");
    const stored = f.database.getRun(f.spec.id)!;
    const echo = stored.spec.mcpSnapshot?.find(tool => tool.serverId === server.id && tool.toolName === "echo");
    expect(echo).toBeDefined();
    expect(echo?.semanticContractHash).toBeTruthy();
    if (drift === "legacy_hash") {
      f.database.saveRun({ ...stored.spec, mcpSnapshot: stored.spec.mcpSnapshot!.map(tool => {
        if (tool.name !== echo!.name) return tool;
        const { semanticContractHash: _legacyMissing, ...legacy } = tool;
        return { ...legacy, contractHash: "older-runtime-contract-hash" };
      }) }, "paused");
    } else {
      const acquire = f.mcp.acquire.bind(f.mcp);
      vi.spyOn(f.mcp, "acquire").mockImplementation(async (...args) => {
        const lease = await acquire(...args);
        const listTools = lease.connection.listTools.bind(lease.connection);
        // Keep a real connected stdio server/lease and change only its returned executable schema.
        vi.spyOn(lease.connection, "listTools").mockImplementation(async signal => (await listTools(signal)).map(tool => tool.name === "echo"
          ? { ...tool, inputSchema: { type: "object", properties: { value: { type: "number" } } } } : tool));
        return lease;
      });
    }
    const requestsBeforeResume = f.requests.length;
    const eventsBeforeResume = f.events.length;
    const completed = await f.run(() => f.engine.resume(f.spec.id, f.profile));
    expect(completed.status, JSON.stringify({ text: completed.text, stop: completed.stop, workflow: f.latest() })).toBe("completed");
    const resumedRequests = f.requests.slice(requestsBeforeResume);
    expect(resumedRequests.length).toBeGreaterThan(0);
    expect(resumedRequests.every(request => !request.tools.some(tool => tool.name === echo!.name))).toBe(true);
    expect(resumedRequests[0]?.messages.some(message => message.role === "user" && message.content.some(part => part.type === "text"
      && part.trust === "untrusted_tool" && part.text.includes("MCP availability diagnostics") && part.text.includes("contract changed") && part.text.includes("echo")))).toBe(true);
    expect(f.events.slice(eventsBeforeResume).some(event => event.type === "tool_started" && (event.call.name === echo!.name || event.origin?.serverId === server.id))).toBe(false);
    expect(f.events.slice(eventsBeforeResume).some(event => event.type === "error" && event.code === "RUN_FAILED")).toBe(false);
    expect(f.latest()?.requirements).toEqual(requirements);
    expect(f.latest()?.sequential?.steps.map(step => step.id)).toEqual(["rain"]);
    expect(f.latest()?.epoch).toBe(checkpoint.workflow?.epoch);
    expect(f.commands).toEqual([localCommand, integrationCommand]);
    expect(f.latest()?.requirementReceipts).toHaveLength(requirements.length);
    expect(f.events.filter(event => event.type === "text_delta" && event.delta === finalBody)).toHaveLength(1);
  });
});

describe("architecture evidence validity", () => {
  it("accepts successful current source read before the formal understand call", () => {
    const workflow = new SequentialWorkflow("Improve rain", () => {}, undefined, {}, "change");
    workflow.observe({ id: "early-source", name: "read_file", input: { path: "rain.mjs" } }, { output: originalSource });
    workflow.advance({ action: "understand", summary: "Improve rain contrast", requirements });
    workflow.advance({ action: "architecture", summary: "rain.mjs owns contrast and cadence", evidenceIds: ["early-source"] });
    expect(workflow.state.sequential?.evidenceIds).toEqual(["early-source"]);
    expect(workflow.state.sequential?.architectureEpoch).toBe(workflow.state.epoch);
  });

  it.each(["failed", "truncated", "stale_revision", "stale_epoch"] as const)("still rejects %s repository evidence", async kind => {
    const workflow = new SequentialWorkflow("Improve rain", () => {}, undefined, {}, "change");
    workflow.observe({ id: "invalid-source", name: "read_file", input: { path: "rain.mjs" } }, {
      output: originalSource, ...(kind === "failed" ? { isError: true } : {}), ...(kind === "truncated" ? { truncated: true } : {}),
    });
    if (kind === "stale_revision") workflow.applyEffect({ kind: "repository_write", changedFiles: ["rain.mjs"] });
    if (kind === "stale_epoch") workflow.state.observations[0]!.epoch = "earlier-runtime-epoch";
    workflow.advance({ action: "understand", summary: "Improve rain contrast", requirements });
    const result = await workflow.planningTool().execute({ action: "architecture", summary: "rain.mjs owns contrast and cadence", evidenceIds: ["invalid-source"] }, {
      runId: "architecture-evidence", workspacePath: tmpdir(), grants: [], signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ isError: true, output: { evidenceErrors: [{ id: "invalid-source", reason: kind === "failed" ? "read_failed" : kind === "truncated" ? "output_truncated" : "version_mismatch" }] } });
    expect(workflow.state.sequential?.architectureEpoch).toBe("");
  });
});
