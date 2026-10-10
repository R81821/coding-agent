import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, VerificationItemSchema, nowIso, type AgentEvent, type ModelRequest, type RunCheckpoint, type RunSpec, type VerificationItem, type VerificationResult } from "@harness/protocol";
import { createDefaultToolRegistry, runProcess } from "@harness/tools";
import { activeElapsedMs, reconcileTaskExecutions, restoredElapsedMs, reusableVerificationResults, verificationItemFingerprint, type VerificationProgress } from "../packages/core/src/durable-recovery.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";
import { snapshotWorkspace, workspaceFingerprint } from "../packages/core/src/workspace-impact.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "harness-durable-recovery-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.mjs"), "export const value = 7;\n");
  const vault = await VaultCrypto.open(join(root, "key.json"), "durable-recovery-password");
  const dbPath = join(root, "state.sqlite");
  let database = await HarnessDatabase.open(dbPath, vault);
  cleanup.push(async () => {
    database.close(); vault.dispose();
    const withinTemp = relative(tmpdir(), root);
    if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, get database() { return database; }, async reopen() { database.close(); database = await HarnessDatabase.open(dbPath, vault); return database; } };
}

function spec(workspace: string): RunSpec {
  return { id: "run-durable", sessionId: "session-durable", taskMode: "analysis", request: "Inspect source.mjs and report its exported value", workspacePath: workspace,
    profileId: DEFAULT_PROFILE.id, attachments: [], grants: [], createdAt: nowIso(), budget: { ...DEFAULT_PROFILE.budget, maxTurns: 10, maxToolCalls: 16, maxDurationMs: 60_000 } };
}

function checkpoint(run: RunSpec, overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return { id: "checkpoint-durable", runId: run.id, sequence: 10, reason: "manual", status: "paused", elapsedMs: 7_000,
    transcript: [{ role: "user", content: [{ type: "text", text: run.request, trust: "user_request" }] }],
    usage: { inputTokens: 100, outputTokens: 25, estimatedUsd: 1.25, costKnown: true }, turns: 2, toolCalls: 3,
    repairAttemptsUsed: 1, pendingNonIdempotentToolCalls: [], createdAt: nowIso(), ...overrides };
}

function engineFixture(database: HarnessDatabase, root: string) {
  const requests: ModelRequest[] = [];
  let mainTurns = 0;
  let unsafeExecutions = 0;
  const model = descriptor({ providerId: "fake", modelId: "durable", displayName: "Durable fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = { id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model], async *stream(request) {
    requests.push(request);
    if (request.purpose === "review") throw new Error("Independent reviews must remain disabled");
    if (request.messages.some(message => message.runtimePrompt === "stop_summary")) { yield { type: "text_delta", delta: "The existing duration budget is exhausted." }; return; }
    if (++mainTurns === 1) yield { type: "tool_call", toolCall: { id: "inspect-durable", name: "read_file", input: { path: "source.mjs" } } };
    else yield { type: "text_delta", delta: "source.mjs exports value = 7. The source inspection is complete." };
  } };
  const tools = createDefaultToolRegistry();
  tools.register({ contract: { name: "unsafe_write", description: "Non-idempotent fixture", inputSchema: { type: "object" }, risk: "write", idempotent: false, timeoutMs: 1000 }, async execute() { unsafeExecutions++; return { output: { executions: unsafeExecutions } }; } });
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(() => engine.close());
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "unsafe_write"] };
  return { engine, requests, profile, get unsafeExecutions() { return unsafeExecutions; } };
}

function resultOf(engine: HarnessEngine, runId: string): Promise<Extract<AgentEvent, { type: "result" }>> {
  return new Promise(resolveResult => { const listener = (event: AgentEvent) => { if (event.type === "result" && event.runId === runId) { engine.off("event", listener); resolveResult(event); } }; engine.on("event", listener); });
}

describe("durable active budgets", { timeout: 20_000 }, () => {
  it("charges resumed active time while excluding time spent paused", () => {
    expect(activeElapsedMs({ startedAt: 1_000, elapsedBeforeStartMs: 7_000 }, 1_200)).toBe(7_200);
    expect(activeElapsedMs({ startedAt: 1_000 }, 900)).toBe(0);
    const legacy = checkpoint(spec(".")); delete legacy.elapsedMs;
    expect(restoredElapsedMs(legacy)).toBe(0);
    expect(restoredElapsedMs(checkpoint(spec("."), { elapsedMs: 25_000 }))).toBe(25_000);
  });

  it("restores consumed counters and active duration across a real database reopen", async () => {
    const f = await storage(); const run = spec(f.workspace);
    f.database.saveRun(run, "paused"); f.database.saveCheckpoint(checkpoint(run));
    const database = await f.reopen(); const h = engineFixture(database, f.root);
    const done = resultOf(h.engine, run.id); h.engine.resume(run.id, h.profile);
    const result = await done; await h.engine.waitForSettlement(run.id);
    expect(result.status, result.text).toBe("completed");
    const saved = database.getLatestCheckpoint(run.id)!;
    expect(saved.turns).toBe(4); expect(saved.toolCalls).toBe(4);
    expect(saved.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, estimatedUsd: 1.25 });
    expect(saved.elapsedMs).toBeGreaterThanOrEqual(7_000);
    expect(saved.repairAttemptsUsed).toBe(1);
    expect(database.getRun(run.id)?.spec.budget).toEqual(run.budget);
  });

  it("does not enlarge an exhausted duration budget when explicitly resumed", async () => {
    const f = await storage(); const run = spec(f.workspace);
    f.database.saveRun(run, "paused"); f.database.saveCheckpoint(checkpoint(run, { elapsedMs: 60_001 }));
    const h = engineFixture(await f.reopen(), f.root); const done = resultOf(h.engine, run.id);
    h.engine.resume(run.id, h.profile); const result = await done; await h.engine.waitForSettlement(run.id);
    expect(result.status).toBe("review"); expect(result.stop?.code).toBe("duration_limit");
    expect(result.stop?.usage.durationMs.used).toBeGreaterThanOrEqual(60_001);
    expect(h.requests.every(request => request.messages.some(message => message.runtimePrompt === "stop_summary"))).toBe(true);
  });

  it("starts a fresh budget only for the user's explicit continuation as a new run", async () => {
    const f = await storage(); const run = spec(f.workspace);
    f.database.createSession({ id: run.sessionId, title: "Inspect exported value", workspacePath: run.workspacePath, profileId: run.profileId, createdAt: nowIso(), updatedAt: nowIso() });
    f.database.saveRun(run, "review"); f.database.saveCheckpoint(checkpoint(run, { status: "review", elapsedMs: 60_001, turns: 10, toolCalls: 16 }));
    f.database.appendEvent({ id: "prior-result", runId: run.id, sequence: 11, at: nowIso(), type: "result", status: "review", text: "Duration budget exhausted", stop: {
      code: "duration_limit", message: "Duration budget exhausted", phase: "inspect_result", pending: ["Inspect source.mjs"], usage: {
        toolCalls: { used: 16, limit: 16 }, modelTurns: { used: 10, limit: 10 }, repairs: { used: 1, limit: null }, usd: { used: 1.25, limit: 5 }, durationMs: { used: 60_001, limit: 60_000 },
      },
    } });
    const h = engineFixture(await f.reopen(), f.root);
    const newId = h.engine.continueRun(run.id, h.profile, "Continue inspecting the original source");
    const result = await resultOf(h.engine, newId); await h.engine.waitForSettlement(newId);
    expect(result.status, result.text).toBe("completed"); expect(newId).not.toBe(run.id);
    const saved = f.database.getLatestCheckpoint(newId)!;
    expect(saved.turns).toBe(2); expect(saved.toolCalls).toBe(1); expect(saved.usage.estimatedUsd).toBe(0);
    expect(saved.elapsedMs).toBeLessThan(60_001);
    expect(f.database.getRun(newId)?.spec.continuation?.runId).toBe(run.id);
  });

  it("parks interrupted runs and never replays an unknown non-idempotent command", async () => {
    const f = await storage(); const run = spec(f.workspace);
    f.database.saveRun(run, "running"); f.database.saveCheckpoint(checkpoint(run, { status: "running", pendingNonIdempotentToolCalls: [{ id: "unknown-write", name: "unsafe_write", input: {} }] }));
    const h = engineFixture(await f.reopen(), f.root);
    expect(h.engine.recoverInterrupted()).toEqual([run.id]); expect(h.engine.isActive(run.id)).toBe(false);
    expect(f.database.getRun(run.id)?.status).toBe("paused"); expect(h.requests).toHaveLength(0);
    const done = resultOf(h.engine, run.id); h.engine.resume(run.id, h.profile); await done; await h.engine.waitForSettlement(run.id);
    expect(h.unsafeExecutions).toBe(0); expect(JSON.stringify(h.requests[0]?.messages)).toContain("not replayed");
  });

  it("rejects resuming a completed run instead of executing its old transcript", async () => {
    const f = await storage(); const run = spec(f.workspace); f.database.saveRun(run, "completed"); f.database.saveCheckpoint(checkpoint(run, { status: "completed" }));
    const h = engineFixture(f.database, f.root);
    expect(() => h.engine.resume(run.id, h.profile)).toThrow(/cannot be resumed from completed/); expect(h.requests).toHaveLength(0);
  });

  it("reconciles child tasks from durable result events without trusting parent claims", async () => {
    const f = await storage(); const run = spec(f.workspace); const workflow = new SequentialWorkflow(run.request, () => {});
    const records = [
      { stepId: "inspect", taskId: "still-running", childRunId: "run-child-running", mode: "read" as const, status: "running" as const, startedAt: nowIso() },
      { stepId: "inspect", taskId: "claimed-complete", childRunId: "run-child-claimed", mode: "read" as const, status: "completed" as const, startedAt: nowIso() },
      { stepId: "inspect", taskId: "actual-complete", childRunId: "run-child-complete", mode: "read" as const, status: "running" as const, startedAt: nowIso() },
    ];
    workflow.state.sequential!.taskExecutions = records;
    f.database.saveRun(run, "running"); f.database.saveCheckpoint(checkpoint(run, { status: "running", workflow: workflow.snapshot() }));
    f.database.saveRun({ ...run, id: "run-child-running", parentRunId: run.id, parentStepId: "inspect" }, "running");
    f.database.saveRun({ ...run, id: "run-child-claimed", parentRunId: run.id, parentStepId: "inspect" }, "completed");
    f.database.saveRun({ ...run, id: "run-child-complete", parentRunId: run.id, parentStepId: "inspect" }, "completed");
    f.database.appendEvent({ id: "child-result", runId: "run-child-complete", sequence: 0, at: nowIso(), type: "result", status: "completed", text: "Inspection completed" });
    const h = engineFixture(await f.reopen(), f.root);
    expect(h.engine.recoverInterrupted()).toEqual(expect.arrayContaining([run.id, "run-child-running"]));
    expect(f.database.getLatestCheckpoint(run.id)?.workflow?.sequential?.taskExecutions.map(record => record.status)).toEqual(["interrupted", "interrupted", "completed"]);
    expect(h.requests).toHaveLength(0);
    expect(reconcileTaskExecutions([{ ...records[0]!, childRunId: "missing-child" }], f.database, run.id)[0]?.status).toBe("interrupted");
    expect(reconcileTaskExecutions([records[2]!], f.database, "unrelated-parent")[0]?.status).toBe("interrupted");
    expect(reconcileTaskExecutions([{ ...records[2]!, stepId: "unrelated-step" }], f.database, run.id)[0]?.status).toBe("interrupted");
    // A successful child may still have failed the parent's scope or artifact checks.
    expect(reconcileTaskExecutions([{ ...records[2]!, status: "failed", summary: "Child wrote outside its declared scope" }], f.database, run.id)[0]?.status).toBe("failed");
  });
});

async function executeItem(item: VerificationItem, workspace: string, codeFingerprint: string): Promise<VerificationResult> {
  const started = Date.now(); const run = await runProcess("node", ["--test", item.command.slice("node --test ".length)], { cwd: workspace, signal: new AbortController().signal, timeoutMs: item.timeoutMs });
  return { fingerprint: verificationItemFingerprint(codeFingerprint, item, workspace), itemId: item.id, command: item.command, cwd: item.cwd,
    exitCode: run.exitCode, passed: run.exitCode === 0 && !run.timedOut, required: item.required, output: run.stdout + run.stderr, durationMs: Date.now() - started, timedOut: run.timedOut };
}

describe("durable verification progress", { timeout: 20_000 }, () => {
  it("resumes a real suite from successful saved items after storage is reopened", async () => {
    const f = await storage(); await mkdir(join(f.workspace, "test")); await mkdir(join(f.workspace, ".cache"));
    for (const name of ["first", "second"]) await writeFile(join(f.workspace, "test", `${name}.test.mjs`), [
      'import { test } from "node:test";', 'import assert from "node:assert/strict";', 'import { appendFileSync } from "node:fs";',
      'import { value } from "../source.mjs";', `test("${name} checks source", () => { assert.equal(value, 7); appendFileSync(".cache/executions.txt", "${name}\\n"); });`,
    ].join("\n"));
    const items = ["first", "second"].map(id => VerificationItemSchema.parse({ id, command: `node --test test/${id}.test.mjs`, timeoutMs: 10_000, stage: "local" }));
    const snapshot = await snapshotWorkspace(f.workspace); expect(snapshot.complete).toBe(true);
    const codeFingerprint = workspaceFingerprint(snapshot); const first = await executeItem(items[0]!, f.workspace, codeFingerprint); expect(first.passed, first.output).toBe(true);
    const progress: VerificationProgress = { stage: "local", epoch: "epoch-durable", revision: 1, codeFingerprint, startedAt: nowIso(), results: [first], pendingItemIds: [items[1]!.id] };
    const run = spec(f.workspace); f.database.saveRun(run, "paused"); f.database.saveCheckpoint(checkpoint(run, { verificationProgress: progress }));
    const database = await f.reopen(); const saved = database.getLatestCheckpoint(run.id)!;
    const after = await snapshotWorkspace(f.workspace);
    const reused = reusableVerificationResults(saved.verificationProgress, { stage: "local", epoch: progress.epoch, revision: 1, snapshot: after, items, workspacePath: f.workspace });
    expect(reused.map(result => result.itemId)).toEqual(["first"]);
    const resumed = [...reused, ...await Promise.all(items.filter(item => !reused.some(result => result.itemId === item.id)).map(item => executeItem(item, f.workspace, codeFingerprint)))];
    expect(resumed).toHaveLength(2); expect(resumed.every(result => result.passed)).toBe(true);
    expect((await readFile(join(f.workspace, ".cache", "executions.txt"), "utf8")).split("\n").filter(Boolean)).toEqual(["first", "second"]);
    await writeFile(join(f.workspace, "source.mjs"), "export const value = 8;\n");
    expect(reusableVerificationResults(saved.verificationProgress, { stage: "local", epoch: progress.epoch, revision: 1, snapshot: await snapshotWorkspace(f.workspace), items, workspacePath: f.workspace })).toEqual([]);
  });

  it.each(["timeout", "command", "cwd", "stdin", "exitCodes", "stage", "epoch", "revision", "incomplete", "timedOut", "failed", "missingFingerprint"])("rejects saved progress after %s changes", async changed => {
    const f = await storage(); const snapshot = await snapshotWorkspace(f.workspace); const codeFingerprint = workspaceFingerprint(snapshot);
    const item = VerificationItemSchema.parse({ id: "source-test", command: "node --test test/source.test.mjs", timeoutMs: 1000 });
    const result: VerificationResult = { fingerprint: verificationItemFingerprint(codeFingerprint, item, f.workspace), itemId: item.id, command: item.command, cwd: item.cwd, exitCode: 0, passed: true, required: true, output: "passed", durationMs: 10, timedOut: false };
    const progress: VerificationProgress = { stage: "local", epoch: "epoch", revision: 2, codeFingerprint, startedAt: nowIso(), results: [result], pendingItemIds: [] };
    const current = { stage: "local" as "local" | "broader", epoch: "epoch", revision: 2, snapshot, items: [item], workspacePath: f.workspace };
    expect(reusableVerificationResults(progress, current)).toHaveLength(1);
    if (changed === "timeout") item.timeoutMs++;
    if (changed === "command") item.command = "node --test test/other.test.mjs";
    if (changed === "cwd") item.cwd = "test";
    if (changed === "stdin") item.stdin = "different";
    if (changed === "exitCodes") item.expectedExitCodes = [1];
    if (changed === "stage") current.stage = "broader";
    if (changed === "epoch") current.epoch = "new-epoch";
    if (changed === "revision") current.revision++;
    if (changed === "incomplete") current.snapshot = { ...snapshot, complete: false };
    if (changed === "timedOut") result.timedOut = true;
    if (changed === "failed") result.passed = false;
    if (changed === "missingFingerprint") delete result.fingerprint;
    expect(reusableVerificationResults(progress, current)).toEqual([]);
  });
});
