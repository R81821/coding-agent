import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessEngine, ProjectTrustService, type RunReviewService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, RunCheckpointSchema, RunSteerResultSchema, type AgentEvent, type ModelRequest, type RunSpec, type RunStatus } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

async function fixture(options: { onRequest?(request: ModelRequest, index: number): Promise<void>; onFinish?(): Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-steer-lifecycle-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "read-only fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  const crypto = await VaultCrypto.open(join(root, "envelope.json"), "isolated-steering-test-password");
  const databasePath = join(root, "harness.sqlite");
  let database = await HarnessDatabase.open(databasePath, crypto);
  const requests: ModelRequest[] = [];
  const model = descriptor({ providerId: "fake", modelId: "fake-model", displayName: "Fake",
    capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      await options.onRequest?.(request, requests.length);
      yield { type: "text_delta", delta: "The read-only request is complete. No files were modified." };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10, estimatedUsd: 0, costKnown: true } };
    },
  };
  const profile = { ...DEFAULT_PROFILE, id: "default", allowedProviders: [provider.id], toolNames: [],
    verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const } };
  function createEngine() {
    const review = options.onFinish ? { async begin() {}, finish: options.onFinish } as unknown as RunReviewService : undefined;
    return new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database), ...(review ? { review } : {}) });
  }
  let engine = createEngine();
  const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Provide a brief read-only answer.", taskMode: "analysis", workspacePath: workspace,
    profileId: profile.id, attachments: [], grants: [], budget: { maxTurns: 64, maxToolCalls: 64, maxDurationMs: 60_000, maxUsd: 5 }, createdAt: nowIso() };
  database.createSession({ id: spec.sessionId, title: "Steering fixture", workspacePath: workspace, profileId: profile.id, createdAt: nowIso(), updatedAt: nowIso() });
  const value = {
    get engine() { return engine; }, get database() { return database; }, profile, spec, requests,
    seed(status: RunStatus = "paused") {
      database.saveRun(spec, status);
      database.saveCheckpoint({ id: newId("checkpoint"), runId: spec.id, sequence: 0, reason: "manual", status,
        transcript: [{ role: "user", content: [{ type: "text", text: spec.request, trust: "user_request" }] }],
        usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, costKnown: true }, turns: 0, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso() });
    },
    async restart() {
      await engine.close();
      database.close();
      database = await HarnessDatabase.open(databasePath, crypto);
      engine = createEngine();
    },
    async close() {
      await engine.close(); database.close(); crypto.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(value);
  return value;
}

function nextResult(engine: HarnessEngine, runId: string) {
  return new Promise<Extract<AgentEvent, { type: "result" }>>(resolve => {
    const listener = (event: AgentEvent) => { if (event.type === "result" && event.runId === runId) { engine.off("event", listener); resolve(event); } };
    engine.on("event", listener);
  });
}

function steeringParts(request: ModelRequest) {
  return request.messages.filter(message => message.steeringId);
}

describe("durable steering lifecycle", { timeout: 15_000 }, () => {
  it.each([false, true])("retains two identical paused corrections and consumes each once, restart=%s", async restart => {
    const h = await fixture();
    h.seed();
    const original = h.database.getLatestCheckpoint(h.spec.id)!;
    expect(RunCheckpointSchema.parse(original).pendingSteering).toBeUndefined();
    expect(h.engine.steer(h.spec.id, "  Keep the original scope.  ")).toMatchObject({ accepted: true, queued: 1, status: "paused" });
    expect(h.engine.steer(h.spec.id, "Keep the original scope.")).toMatchObject({ accepted: true, queued: 2, status: "paused" });
    const pending = h.database.getLatestCheckpoint(h.spec.id)!.pendingSteering!;
    expect(new Set(pending.map(message => message.id)).size).toBe(2);
    expect(pending.map(message => message.text)).toEqual(["Keep the original scope.", "Keep the original scope."]);
    if (restart) await h.restart();
    const done = nextResult(h.engine, h.spec.id);
    h.engine.resume(h.spec.id, h.profile);
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    const saved = h.database.getLatestCheckpoint(h.spec.id)!;
    expect(saved.pendingSteering).toEqual([]);
    expect(saved.transcript.filter(message => pending.some(item => item.id === message.steeringId))).toHaveLength(2);
    for (const message of pending) {
      const containing = h.requests.filter(request => steeringParts(request).some(part => part.steeringId === message.id));
      expect(containing.length).toBeGreaterThan(0);
      expect(containing.every(request => steeringParts(request).filter(part => part.steeringId === message.id).length === 1)).toBe(true);
    }
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_delivered")).toHaveLength(2);
    expect(h.database.getRun(h.spec.id)?.spec.grants).toEqual([]);
    expect(saved.transcript.filter(message => message.steeringId).every(message => message.role === "user" && message.content.every(part => part.type === "text" && part.trust === "user_request"))).toBe(true);
  });

  it("keeps pumped and pause-requested corrections pending until a resumed model request includes them", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ async onRequest(_request, index) { if (index === 1) { entered.resolve(); await release.promise; } } });
    const paused = nextResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await entered.promise;
    expect(h.engine.steer(h.spec.id, "First correction")).toMatchObject({ accepted: true, queued: 1 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(h.database.listEvents(h.spec.id).some(event => event.type === "steering_delivered")).toBe(false);
    expect(h.engine.pause(h.spec.id)).toBe(true);
    expect(h.engine.steer(h.spec.id, "Second correction")).toMatchObject({ accepted: true, queued: 2 });
    release.resolve();
    expect((await paused).status).toBe("paused");
    await h.engine.waitForSettlement(h.spec.id);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering?.map(message => message.text)).toEqual(["First correction", "Second correction"]);
    const done = nextResult(h.engine, h.spec.id);
    h.engine.resume(h.spec.id, h.profile);
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toEqual([]);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_delivered")).toHaveLength(2);
  });

  it("does not overwrite a correction added synchronously as paused status is published", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ async onRequest(_request, index) { if (index === 1) { entered.resolve(); await release.promise; } } });
    let accepted: unknown;
    h.engine.on("event", (event: AgentEvent) => {
      if (event.runId === h.spec.id && event.type === "status" && event.status === "paused") accepted = h.engine.steer(h.spec.id, "Retain this during settlement");
    });
    const done = nextResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await entered.promise;
    h.engine.pause(h.spec.id);
    release.resolve();
    expect((await done).status).toBe("paused");
    await h.engine.waitForSettlement(h.spec.id);
    expect(accepted).toMatchObject({ accepted: true, queued: 1, status: "paused" });
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering?.map(message => message.text)).toEqual(["Retain this during settlement"]);
  });

  it("delivers a correction accepted inside a fast model request without waiting for a timer", async () => {
    const h = await fixture();
    let accepted: unknown;
    h.engine.on("event", (event: AgentEvent) => {
      if (event.runId === h.spec.id && event.type === "assistant_turn_started" && accepted === undefined)
        accepted = h.engine.steer(h.spec.id, "Include this correction in the answer.");
    });
    const done = nextResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(accepted).toMatchObject({ accepted: true, queued: 1 });
    expect(h.requests.some(request => steeringParts(request).some(message => message.content.some(part => part.type === "text" && part.text === "Include this correction in the answer.")))).toBe(true);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toEqual([]);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_delivered")).toHaveLength(1);
  });

  it("rejects a completed run while cleanup still owns its active-map entry", async () => {
    const finishEntered = deferred(), finishRelease = deferred();
    const h = await fixture({ async onFinish() { finishEntered.resolve(); await finishRelease.promise; } });
    try {
      const done = nextResult(h.engine, h.spec.id);
      h.engine.start(h.spec, h.profile);
      expect((await done).status).toBe("completed");
      await finishEntered.promise;
      expect(h.engine.isActive(h.spec.id)).toBe(true);
      expect(h.engine.steer(h.spec.id, "Late input")).toEqual({ accepted: false, queued: 0, status: "completed" });
      expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toEqual([]);
    } finally { finishRelease.resolve(); await h.engine.waitForSettlement(h.spec.id); }
  });

  it.each(["completed", "review", "failed", "cancelled", "running"] as const)("returns a normal rejection for stored %s without an accepting runtime", async status => {
    const h = await fixture();
    h.seed(status);
    expect(RunSteerResultSchema.parse(h.engine.steer(h.spec.id, "Late input"))).toEqual({ accepted: false, queued: 0, status });
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toBeUndefined();
  });

  it("keeps the eight-message and 4000-character bounds on paused queues", async () => {
    const h = await fixture();
    h.seed();
    expect(() => h.engine.steer(h.spec.id, "   ")).toThrow(/empty/);
    expect(() => h.engine.steer(h.spec.id, "x".repeat(4001))).toThrow(/exceeds/);
    for (let index = 0; index < 8; index++) expect(h.engine.steer(h.spec.id, index === 0 ? "x".repeat(4000) : `Correction ${index}`).queued).toBe(index + 1);
    expect(() => h.engine.steer(h.spec.id, "Ninth correction")).toThrow(/At most 8/);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toHaveLength(8);
    expect(new Set(h.database.listCheckpoints(h.spec.id).map(checkpoint => checkpoint.sequence)).size).toBe(9);
  });

  it("does not acknowledge or keep an in-memory correction when checkpoint persistence fails", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ async onRequest(_request, index) { if (index === 1) { entered.resolve(); await release.promise; } } });
    h.engine.start(h.spec, h.profile);
    await entered.promise;
    const save = vi.spyOn(h.database, "saveCheckpoint").mockImplementationOnce(() => { throw new Error("fixture storage failure"); });
    try {
      expect(() => h.engine.steer(h.spec.id, "Not committed")).toThrow(/fixture storage failure/);
      expect(h.engine.steer(h.spec.id, "Committed instead")).toMatchObject({ accepted: true, queued: 1 });
      expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering?.map(message => message.text)).toEqual(["Committed instead"]);
    } finally { save.mockRestore(); h.engine.pause(h.spec.id); release.resolve(); await h.engine.waitForSettlement(h.spec.id); }
  });

  it("preserves real errors for unknown runs and refuses input during shutdown", async () => {
    const h = await fixture();
    expect(() => h.engine.steer("missing-run", "Correction")).toThrow(/Unknown run/);
    h.seed();
    await h.engine.close();
    expect(() => h.engine.steer(h.spec.id, "Correction")).toThrow(/Engine is closed/);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toBeUndefined();
  });

  it("adds paused input to the durable conversation and first resumed model request without another continue action", async () => {
    const h = await fixture();
    h.seed();
    const done = nextResult(h.engine, h.spec.id);
    const result = RunSteerResultSchema.parse(await h.engine.steerAndResume(h.spec.id, "Use this revised goal immediately.", h.profile));
    expect(result).toMatchObject({ accepted: true, resumed: true });
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    if (!result.accepted) throw new Error("Input was unexpectedly rejected");
    expect(steeringParts(h.requests[0]!)).toHaveLength(1);
    expect(steeringParts(h.requests[0]!)[0]).toMatchObject({ role: "user", steeringId: result.messageId,
      content: [{ type: "text", text: "Use this revised goal immediately.", trust: "user_request" }] });
    const events = h.database.listEvents(h.spec.id);
    expect(events.filter(event => event.type === "steering_submitted")).toEqual([
      expect.objectContaining({ type: "steering_submitted", messageId: result.messageId, text: "Use this revised goal immediately." }),
    ]);
    expect(events.filter(event => event.type === "steering_delivered")).toEqual([
      expect.objectContaining({ type: "steering_delivered", messageId: result.messageId }),
    ]);
    expect(events.findIndex(event => event.type === "steering_submitted")).toBeLessThan(events.findIndex(event => event.type === "assistant_turn_started"));
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toEqual([]);
    expect(h.database.getRun(h.spec.id)?.spec.id).toBe(h.spec.id);
  });

  it("shares the resume action while preserving two separate messages submitted during the paused event", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ async onRequest(_request, index) { if (index === 1) { entered.resolve(); await release.promise; } } });
    const resume = vi.spyOn(h.engine, "resume");
    let submissions: Promise<unknown>[] = [];
    h.engine.on("event", (event: AgentEvent) => {
      if (event.runId === h.spec.id && event.type === "status" && event.status === "paused" && !submissions.length) {
        expect(h.engine.isActive(h.spec.id)).toBe(true);
        submissions = [h.engine.steerAndResume(h.spec.id, "First correction", h.profile), h.engine.steerAndResume(h.spec.id, "Second correction", h.profile)];
      }
    });
    const paused = nextResult(h.engine, h.spec.id);
    h.engine.start(h.spec, h.profile);
    await entered.promise;
    h.engine.pause(h.spec.id);
    release.resolve();
    expect((await paused).status).toBe("paused");
    const results = await Promise.all(submissions);
    expect(results).toEqual([expect.objectContaining({ accepted: true, resumed: true }), expect.objectContaining({ accepted: true, resumed: true })]);
    expect(resume).toHaveBeenCalledTimes(1);
    await h.engine.waitForSettlement(h.spec.id);
    expect(h.database.getRun(h.spec.id)?.status).toBe("completed");
    const firstResumed = h.requests[1]!;
    expect(steeringParts(firstResumed).map(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []).join(""))).toEqual(["First correction", "Second correction"]);
    const submitted = h.database.listEvents(h.spec.id).filter(event => event.type === "steering_submitted");
    const delivered = h.database.listEvents(h.spec.id).filter(event => event.type === "steering_delivered");
    expect(new Set(submitted.map(event => event.messageId)).size).toBe(2);
    expect(delivered.map(event => event.messageId)).toEqual(submitted.map(event => event.messageId));
  });

  it("includes new input in the first resumed request even when pausing left an empty transcript", async () => {
    const h = await fixture();
    h.seed();
    const checkpoint = h.database.getLatestCheckpoint(h.spec.id)!;
    h.database.saveCheckpoint({ ...checkpoint, id: newId("checkpoint"), sequence: checkpoint.sequence + 1, transcript: [] });
    const done = nextResult(h.engine, h.spec.id);
    expect(await h.engine.steerAndResume(h.spec.id, "Use the amended goal before the first answer.", h.profile)).toMatchObject({ accepted: true, resumed: true });
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(steeringParts(h.requests[0]!)[0]?.content).toEqual([{ type: "text", text: "Use the amended goal before the first answer.", trust: "user_request" }]);
    expect(h.requests[0]!.messages.some(message => message.role === "user" && message.content.some(part => part.type === "text" && part.text.includes(h.spec.request)))).toBe(true);
  });

  it("waits for an in-flight turn to pause before starting the revised conversation", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ async onRequest(_request, index) { if (index === 1) { entered.resolve(); await release.promise; } } });
    h.engine.start(h.spec, h.profile);
    await entered.promise;
    h.engine.pause(h.spec.id);
    let resolved = false;
    const submission = h.engine.steerAndResume(h.spec.id, "Think again with this new requirement.", h.profile).then(result => { resolved = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    expect(h.requests).toHaveLength(1);
    release.resolve();
    expect(await submission).toMatchObject({ accepted: true, resumed: true });
    await h.engine.waitForSettlement(h.spec.id);
    expect(steeringParts(h.requests[1]!)[0]?.content).toEqual([{ type: "text", text: "Think again with this new requirement.", trust: "user_request" }]);
    expect(h.database.getRun(h.spec.id)?.status).toBe("completed");
  });

  it("keeps accepted input after a resume failure and consumes it once after a later manual resume", async () => {
    const h = await fixture();
    h.seed();
    const resume = vi.spyOn(h.engine, "resume").mockImplementationOnce(() => { throw new Error("fixture resume failure"); });
    const result = await h.engine.steerAndResume(h.spec.id, "Do not lose this human message.", h.profile);
    expect(result).toMatchObject({ accepted: true, resumed: false, resumeError: "fixture resume failure", status: "paused" });
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toHaveLength(1);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_submitted")).toHaveLength(1);
    expect(h.requests).toEqual([]);
    resume.mockRestore();
    await h.restart();
    const done = nextResult(h.engine, h.spec.id);
    h.engine.resume(h.spec.id, h.profile);
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(steeringParts(h.requests[0]!)).toHaveLength(1);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_submitted")).toHaveLength(1);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_delivered")).toHaveLength(1);
  });

  it("does not replay an unresolved non-idempotent call before reconsidering the new user message", async () => {
    const h = await fixture();
    h.seed();
    const checkpoint = h.database.getLatestCheckpoint(h.spec.id)!;
    const uncertain = { id: "unknown-write", name: "write_file", input: { path: "source.txt", content: "Never replay" } };
    h.database.saveCheckpoint({ ...checkpoint, id: newId("checkpoint"), sequence: checkpoint.sequence + 1,
      transcript: [...checkpoint.transcript, { role: "assistant", content: [{ type: "tool_call", toolCallId: uncertain.id, name: uncertain.name, input: uncertain.input }] }],
      pendingNonIdempotentToolCalls: [uncertain] });
    const done = nextResult(h.engine, h.spec.id);
    expect(await h.engine.steerAndResume(h.spec.id, "Cancel the write plan; give me an explanation.", h.profile)).toMatchObject({ accepted: true, resumed: true });
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(steeringParts(h.requests[0]!)[0]?.content).toEqual([{ type: "text", text: "Cancel the write plan; give me an explanation.", trust: "user_request" }]);
    expect(h.requests[0]!.messages.some(message => message.role === "tool" && message.content.some(part => part.type === "tool_result" && part.toolCallId === uncertain.id))).toBe(true);
    expect(h.database.listEvents(h.spec.id).some(event => event.type === "tool_started" && event.call.id === uncertain.id)).toBe(false);
    expect(h.database.getRun(h.spec.id)?.spec.grants).toEqual([]);
  });

  it("preserves existing budgets when automatically resuming after a new user message", async () => {
    const h = await fixture();
    h.seed();
    const checkpoint = h.database.getLatestCheckpoint(h.spec.id)!;
    h.database.saveCheckpoint({ ...checkpoint, id: newId("checkpoint"), sequence: checkpoint.sequence + 1, turns: h.spec.budget.maxTurns,
      usage: { inputTokens: 900, outputTokens: 90, estimatedUsd: 0.8, costKnown: true } });
    const done = nextResult(h.engine, h.spec.id);
    expect(await h.engine.steerAndResume(h.spec.id, "Reconsider without granting extra budget.", h.profile)).toMatchObject({ accepted: true, resumed: true });
    expect((await done).status).toBe("review");
    await h.engine.waitForSettlement(h.spec.id);
    expect(h.requests).toEqual([]);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.pendingSteering).toHaveLength(1);
    expect(h.database.getRun(h.spec.id)?.spec.budget).toEqual(h.spec.budget);
    expect(h.database.getLatestCheckpoint(h.spec.id)?.usage).toEqual({ inputTokens: 900, outputTokens: 90, estimatedUsd: 0.8, costKnown: true });
  });

  it("acknowledges committed input even when a presentation subscriber throws", async () => {
    const h = await fixture();
    h.seed();
    h.engine.on("event", (event: AgentEvent) => { if (event.type === "steering_submitted") throw new Error("fixture presentation failure"); });
    const done = nextResult(h.engine, h.spec.id);
    expect(await h.engine.steerAndResume(h.spec.id, "This submission is already committed.", h.profile)).toMatchObject({ accepted: true, resumed: true });
    expect((await done).status).toBe("completed");
    await h.engine.waitForSettlement(h.spec.id);
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_submitted")).toHaveLength(1);
  });

  it("refuses to revive a completed run when paused-resume submission is requested", async () => {
    const h = await fixture();
    h.seed("completed");
    const resume = vi.spyOn(h.engine, "resume");
    expect(await h.engine.steerAndResume(h.spec.id, "Late message", h.profile)).toEqual({ accepted: false, queued: 0, status: "completed" });
    expect(resume).not.toHaveBeenCalled();
    expect(h.database.listEvents(h.spec.id).filter(event => event.type === "steering_submitted")).toEqual([]);
  });
});
