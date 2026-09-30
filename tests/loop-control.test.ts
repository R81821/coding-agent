import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type PlanSpec } from "@harness/protocol";
import { createDefaultToolRegistry, ToolRegistry } from "@harness/tools";
import { sequentialPrelude } from "./sequential-fixture.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {});
});

const model = descriptor({
  providerId: "fake", modelId: "fake-model", displayName: "Fake",
  capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" },
});

interface Harness {
  engine: HarnessEngine;
  database: HarnessDatabase;
  root: string;
  spec: ReturnType<typeof makeSpec>;
  profile: typeof DEFAULT_PROFILE;
}

function makeSpec(root: string) {
  return {
    id: newId("run"), sessionId: newId("session"), request: "Inspect a.txt and report.",
    workspacePath: root, profileId: "default", attachments: [] as never[],
    budget: { maxTurns: 10_000, maxToolCalls: 10_000, maxDurationMs: 600_000, maxUsd: 5 },
    grants: [] as never[], createdAt: nowIso(),
  };
}

async function harness(stream: (request: ModelRequest, callIndex: number) => AsyncIterable<ProviderStreamEvent>): Promise<Harness> {
  return harnessWith(stream, createDefaultToolRegistry());
}

async function harnessWith(stream: (request: ModelRequest, callIndex: number) => AsyncIterable<ProviderStreamEvent>, tools: ToolRegistry): Promise<Harness> {
  let call = 0;
  const provider: ModelProvider = {
    id: "fake",
    async listModels() { return [model]; },
    stream: (request: ModelRequest) => stream(request, ++call),
    async health() { return true; },
    estimateCost() { return 0; },
  };
  const root = await mkdtemp(join(tmpdir(), "harness-control-test-"));
  temporary.push(root);
  const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
  const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
  const engine = new HarnessEngine({
    database,
    providers: [provider],
    tools,
    memory: new MemoryService(database),
    skills: new SkillService(join(root, "skills")),
    projectTrust: new ProjectTrustService(database),
  });
  await writeFile(join(root, "a.txt"), "hello world\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  const profile = {
    ...DEFAULT_PROFILE, id: "default", allowedProviders: ["fake"], toolNames: ["read_file"],
    verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const },
  };
  return { engine, database, root, spec: makeSpec(root), profile };
}

function waitForResult(engine: HarnessEngine, runId: string): Promise<Extract<AgentEvent, { type: "result" }>> {
  return new Promise((resolve) => {
    engine.on("event", (event: AgentEvent) => { if (event.runId === runId && event.type === "result") resolve(event); });
  });
}

/**
 * A provider whose every model turn parks on a gate the test opens explicitly. Timing-based tests
 * cannot reliably pause or steer a run that finishes in a few milliseconds; this keeps the run alive
 * until the test has taken the action it wants to observe.
 */
function gated(seen: string[], toolsPerTurn: number, gate: () => Promise<void>, blockAfter = 0) {
  return async function* (request: ModelRequest, callIndex: number): AsyncIterable<ProviderStreamEvent> {
    seen.push(request.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n"));
    // Past `blockAfter` the run parks here until the test opens the gate. Without this an
    // in-memory run finishes all its turns before the test gets a chance to pause or steer it.
    if (blockAfter > 0 && callIndex > blockAfter) await gate();
    if (callIndex <= toolsPerTurn) yield { type: "tool_call", toolCall: { id: `call-${callIndex}`, name: "read_file", input: { path: "a.txt" } } };
    else yield { type: "text_delta", delta: `answer ${callIndex}` };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0 } };
  };
}

/** Wait for the engine to finish retiring a run: the result event precedes the active-map cleanup. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A run that parks inside its first model request, so "the run is active" cannot race a fast turn. */
function gatedBlockFirst(seen: string[], gate: () => Promise<void>) {
  return async function* (): AsyncIterable<ProviderStreamEvent> {
    await gate();
    seen.push("released");
    yield { type: "text_delta", delta: "done" };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 } };
  };
}

/** Poll until the condition holds, so a test never depends on how fast a run happens to be. */
async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A gate that stays shut until open() is called, or the deadline passes. */
function makeGate() {
  let release: (() => void) | undefined;
  let opened = false;
  const waiting: (() => void)[] = [];
  return {
    async wait() {
      if (opened) return;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        const timer = setTimeout(() => { opened = true; resolve(); }, 20_000);
        release = () => { clearTimeout(timer); resolve(); };
      });
    },
    open() {
      opened = true;
      release?.();
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

describe("run control", { timeout: 20_000 }, () => {
  it("pauses at a turn boundary, keeps the checkpoint, and resumes the same task", async () => {
    const seen: string[] = [];
    const gate = makeGate();
    // Three turns run, then the run parks inside its fourth model request until the gate opens.
    const h = await harness(gated(seen, 1_000, () => gate.wait(), 3));
    const first = waitForResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await waitUntil(() => seen.length >= 4);
    await waitUntil(() => h.database.listEvents(h.spec.id).some((event) => event.type === "tool_finished"));
    expect(h.engine.isActive(h.spec.id)).toBe(true);
    expect(h.engine.pause(h.spec.id)).toBe(true);
    gate.open();
    const paused = await first;
    expect(paused.status).toBe("paused");
    expect(h.database.getRun(h.spec.id)?.status).toBe("paused");
    const checkpoints = h.database.listCheckpoints(h.spec.id, 5);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]!.transcript.length).toBeGreaterThan(0);

    // Resume continues the same run: the stored transcript comes back and the model carries on.
    await settle();
    const turnsBefore = seen.length;
    const second = waitForResult(h.engine, h.spec.id);
    h.engine.resume(h.spec.id, h.profile);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.length).toBeGreaterThan(turnsBefore);
    expect(h.database.listEvents(h.spec.id)).toContainEqual(expect.objectContaining({ type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }));
    h.engine.cancel(h.spec.id);
    const resumed = await second;
    expect(resumed.status).toBe("cancelled");
  });

  it("delivers a steering message to the model without discarding the run", async () => {
    const seen: string[] = [];
    const gate = makeGate();
    const h = await harness(gated(seen, 1_000, () => gate.wait(), 3));
    const done = waitForResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await waitUntil(() => seen.length >= 4);

    expect(h.engine.steer(h.spec.id, "Stop reading a.txt; look at b.txt instead.")).toEqual({ queued: 1 });
    // The run is mid-request; the correction is delivered at the next turn boundary.
    expect(seen.some((text) => text.includes("Stop reading a.txt"))).toBe(false);
    gate.open();
    await waitUntil(() => seen.some((text) => text.includes("Stop reading a.txt")));

    // The correction reaches the model as a user message on a later request...
    expect(seen.some((text) => text.includes("Stop reading a.txt"))).toBe(true);
    // ...and it is recorded on the event stream at the point of delivery.
    const delivered = h.database.listEvents(h.spec.id).filter((event) => event.type === "steering_delivered");
    expect(delivered).toHaveLength(1);
    h.engine.cancel(h.spec.id);
    await done;
  });

  it("unblocks a run that is paused while waiting for plan approval", async () => {
    // A write call needs an approved plan, so the run parks on that decision. Pausing from there
    // used to leave it waiting forever on a dialog the user had already dismissed: the loop had no
    // turn boundary left to reach and the run stayed in the engine's active set.
    const registry = createDefaultToolRegistry();
    registry.register({
      contract: { name: "write_note", description: "write a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
      execute: async (input) => ({ output: { written: String((input as { text?: unknown }).text ?? "") } }),
    });
    const h = await harnessWith(async function* (_request: ModelRequest, callIndex: number) {
      if (callIndex === 1) yield* sequentialPrelude("fixture-verify", "a.txt");
      yield { type: "tool_call", toolCall: { id: `call-${callIndex}`, name: "write_note", input: { text: "note" } } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0 } };
    }, registry);
    const spec = { ...h.spec, request: "write a note and keep going" };
    const profile = { ...h.profile, toolNames: ["read_file", "write_note"], verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const } };

    const done = waitForResult(h.engine, spec.id);
    h.engine.start(spec, profile);
    await waitUntil(() => h.database.getRun(spec.id)?.status === "waiting_approval");
    expect(h.database.getRun(spec.id)?.status).toBe("waiting_approval");
    expect(h.engine.pause(spec.id)).toBe(true);

    const result = await done;
    expect(result.status).toBe("paused");
    expect(h.database.getRun(spec.id)?.status).toBe("paused");
    // ...and the paused run is genuinely resumable rather than stuck in the active set.
    await settle();
    expect(h.engine.isActive(spec.id)).toBe(false);
    const second = waitForResult(h.engine, spec.id);
    h.engine.resume(spec.id, profile);
    await waitUntil(() => h.engine.isActive(spec.id));
    expect(h.engine.isActive(spec.id)).toBe(true);
    h.engine.cancel(spec.id);
    await second;
  });

  it("retires a plan approval once its run ends", async () => {
    // Otherwise the surface keeps offering a decision whose run is gone, and pressing it fails with
    // "Plan is not attached to an active run".
    const registry = createDefaultToolRegistry();
    registry.register({
      contract: { name: "write_note", description: "write a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
      execute: async () => ({ output: { written: true } }),
    });
    const h = await harnessWith(async function* (_request: ModelRequest, callIndex: number) {
      if (callIndex === 1) yield* sequentialPrelude("fixture-verify", "a.txt");
      yield { type: "tool_call", toolCall: { id: `call-${callIndex}`, name: "write_note", input: { text: "note" } } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0 } };
    }, registry);
    const spec = { ...h.spec, request: "write a note" };
    const profile = { ...h.profile, toolNames: ["read_file", "write_note"], verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const } };

    const done = waitForResult(h.engine, spec.id);
    h.engine.start(spec, profile);
    await waitUntil(() => h.database.getRun(spec.id)?.status === "waiting_approval");
    expect(h.database.getPlanForRun(spec.id)?.status).toBe("awaiting_approval");

    h.engine.cancel(spec.id);
    await done;
    await waitUntil(() => h.engine.isActive(spec.id) === false);
    expect(h.database.getPlanForRun(spec.id)?.status).toBe("rejected");
  });

  it("retires a plan left awaiting approval by an earlier process", async () => {
    // Reproduces a restart: the plan is still marked awaiting_approval in storage, but no pending
    // decision exists in this process. Reusing it parks the run on a promise nothing can resolve,
    // so every approval click fails with "Plan is not attached to an active run".
    const registry = createDefaultToolRegistry();
    registry.register({
      contract: { name: "write_note", description: "write a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
      execute: async () => ({ output: { written: true } }),
    });
    const h = await harnessWith(async function* (_request: ModelRequest, callIndex: number) {
      if (callIndex === 1) yield* sequentialPrelude("fixture-verify", "a.txt");
      yield { type: "tool_call", toolCall: { id: `call-${callIndex}`, name: "write_note", input: { text: "note" } } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0 } };
    }, registry);
    const spec = { ...h.spec, request: "write a note" };
    const profile = { ...h.profile, toolNames: ["read_file", "write_note"], verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const } };
    const now = nowIso();
    h.database.savePlan({
      id: "plan-stale", runId: spec.id, goal: spec.request, version: 1, status: "awaiting_approval", steps: [],
      scope: { pathGlobs: [], commandPrefixes: [], networkDomains: [], maxRisk: "write" }, createdAt: now, updatedAt: now,
    });

    const done = waitForResult(h.engine, spec.id);
    h.engine.start(spec, profile);
    // The stale plan is retired and replaced: the run produces a new version that a decision can
    // actually reach, instead of parking forever on the one left behind.
    await waitUntil(() => (h.database.getPlanForRun(spec.id)?.version ?? 0) >= 2, 12_000);
    const fresh = h.database.getPlanForRun(spec.id)!;
    expect(fresh.id).toBe("plan-stale");
    expect(fresh.version).toBeGreaterThanOrEqual(2);
    expect(fresh.status).toBe("awaiting_approval");
    // The decisive part: the new version has a live decision behind it, so approving it resolves
    // instead of throwing "Plan is not attached to an active run".
    let decided: PlanSpec | undefined;
    expect(() => { decided = h.engine.decidePlan(fresh.id, fresh.version, true, "test"); }).not.toThrow();
    expect(decided?.status).toBe("awaiting_approval");
    await waitUntil(() => h.database.getPlanForRun(spec.id)?.status === "approved", 12_000);
    h.engine.cancel(spec.id);
    await done;
    h.engine.cancel(spec.id);
    await done;
  });

  it("recovers an interrupted run as paused, never as a pending approval", async () => {
    // A run left behind by an earlier process has no pending decision behind it. Recovering it as
    // `waiting_approval` made the surface open an approval dialog on startup whose decision had
    // nowhere to go, so every click failed with "Plan is not attached to an active run".
    const h = await harness(async function* () {
      yield { type: "text_delta", delta: "done" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 } };
    });
    h.database.saveRun(h.spec, "running");
    h.database.saveCheckpoint({
      id: newId("checkpoint"), runId: h.spec.id, sequence: 3, reason: "tool_batch", status: "running",
      transcript: [{ role: "user", content: [{ type: "text", text: "go", trust: "user_request" }] }],
      usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0, costKnown: true },
      turns: 1, toolCalls: 1, repairAttemptsUsed: 0,
      // The undecided non-idempotent call is exactly the case that used to become waiting_approval.
      pendingNonIdempotentToolCalls: [{ id: "call-1", name: "terminal", input: { command: "echo hi" } }],
      createdAt: nowIso(),
    });

    expect(h.engine.recoverInterrupted()).toEqual([h.spec.id]);
    expect(h.database.getRun(h.spec.id)?.status).toBe("paused");
  });

  it("refuses steering and pause for a run that is not active", async () => {
    const h = await harness(gated([], 0, async () => {}));
    expect(h.engine.pause("missing-run")).toBe(false);
    expect(() => h.engine.steer("missing-run", "hello")).toThrow(/not active/);
  });

  it("rejects an empty or oversized steering message", async () => {
    const gate = makeGate();
    // Park inside the very first model request: the run must be unambiguously active for these
    // assertions, including on a machine fast enough to finish a whole turn in a few milliseconds.
    const h = await harness(gatedBlockFirst([], () => gate.wait()));
    const done = waitForResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await waitUntil(() => h.engine.isActive(h.spec.id));
    expect(h.engine.isActive(h.spec.id)).toBe(true);
    expect(() => h.engine.steer(h.spec.id, "   ")).toThrow(/empty/);
    expect(() => h.engine.steer(h.spec.id, "x".repeat(4_001))).toThrow(/exceeds/);
    gate.open();
    h.engine.cancel(h.spec.id);
    await done;
  });
});
