import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Register before start/resume, and stop listening after the specific run settles. */
function nextResult(engine: HarnessEngine, runId: string) {
  return new Promise<Extract<AgentEvent, { type: "result" }>>(resolve => {
    const listener = (event: AgentEvent) => {
      if (event.runId !== runId || event.type !== "result") return;
      engine.off("event", listener);
      resolve(event);
    };
    engine.on("event", listener);
  });
}

async function fixture(beforeRequest?: (request: ModelRequest, turn: number) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "harness-generation-engine-"));
  const state = await mkdtemp(join(tmpdir(), "harness-generation-state-"));
  const vault = await VaultCrypto.open(join(state, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(state, "db.sqlite"), vault);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const requests: ModelRequest[] = [];
  const turns = new Map<string, number>();
  const model = descriptor({ providerId: "generation", modelId: "large-context", displayName: "Generation fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 1_000_000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "generation", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      const turn = (turns.get(request.runId) ?? 0) + 1;
      turns.set(request.runId, turn);
      requests.push(structuredClone(request));
      await beforeRequest?.(request, turn);
      const hasRead = request.messages.some(message => message.content.some(part => part.type === "tool_result" && part.toolCallId.startsWith("generation-read-")));
      if (!hasRead) yield { type: "tool_call", toolCall: { id: `generation-read-${turn}`, name: "read_file", input: { path: "source.ts" } } };
      else yield { type: "text_delta", delta: "source.ts 导出 value = 1，分析完成。" };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20, estimatedUsd: 0, costKnown: true } };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(state, "skills")), projectTrust: new ProjectTrustService(database) });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [provider.id], toolNames: ["read_file"], generationPolicy: { maxOutputTokens: 6144, reviewMaxOutputTokens: 8192 } };
  function spec(overrides: Partial<RunSpec> = {}): RunSpec {
    return { id: newId("run"), sessionId: newId("session"), request: "分析 source.ts 的导出值", workspacePath: workspace, profileId: profile.id, budget: { ...DEFAULT_PROFILE.budget, maxTurns: 8 }, workflowVersion: 2, taskMode: "analysis", attachments: [], grants: [], createdAt: nowIso(), ...overrides };
  }
  async function finish(run: RunSpec) {
    const result = nextResult(engine, run.id);
    engine.start(run, profile);
    const event = await result;
    await engine.waitForSettlement(run.id);
    expect(event.status, event.text).toBe("completed");
    return event;
  }
  return {
    engine, database, requests, profile, spec, finish,
    async close() {
      await engine.close();
      database.close();
      vault.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
}

describe("engine generation policy", { timeout: 15_000 }, () => {
  it("sends the Profile main limit on real requests and freezes both limits in the new RunSpec", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.finish(run);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.map(request => request.maxOutputTokens)).toEqual([6144, 6144]);
      expect(h.database.getRun(run.id)?.spec.generationPolicy).toEqual({ maxOutputTokens: 6144, reviewMaxOutputTokens: 8192 });
      expect(run).not.toHaveProperty("generationPolicy");
    } finally { await h.close(); }
  });

  it("applies edited settings to new runs while an active run keeps its frozen limits", async () => {
    const entered = deferred(), release = deferred();
    let blockedRunId = "";
    const h = await fixture(async (request, turn) => {
      if (request.runId === blockedRunId && turn === 1) { entered.resolve(); await release.promise; }
    });
    try {
      const firstRun = h.spec();
      blockedRunId = firstRun.id;
      const firstResult = nextResult(h.engine, firstRun.id);
      h.engine.start(firstRun, h.profile);
      await entered.promise;
      // Mutating the original Profile object also probes whether the run accidentally kept an alias.
      h.profile.generationPolicy!.maxOutputTokens = 16384;
      h.profile.generationPolicy!.reviewMaxOutputTokens = 24576;
      h.database.saveProfile(h.profile);
      release.resolve();
      expect((await firstResult).status).toBe("completed");
      await h.engine.waitForSettlement(firstRun.id);
      expect(h.requests.filter(request => request.runId === firstRun.id).map(request => request.maxOutputTokens)).toEqual([6144, 6144]);
      expect(h.database.getRun(firstRun.id)?.spec.generationPolicy).toEqual({ maxOutputTokens: 6144, reviewMaxOutputTokens: 8192 });
      const nextRun = h.spec();
      await h.finish(nextRun);
      expect(h.requests.filter(request => request.runId === nextRun.id).map(request => request.maxOutputTokens)).toEqual([16384, 16384]);
      expect(h.database.getRun(nextRun.id)?.spec.generationPolicy).toEqual({ maxOutputTokens: 16384, reviewMaxOutputTokens: 24576 });
    } finally { release.resolve(); await h.close(); }
  });

  it("resumes the same paused run using its original frozen settings after the Profile changes", async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture(async (_request, turn) => { if (turn === 1) { entered.resolve(); await release.promise; } });
    try {
      const run = h.spec();
      const paused = nextResult(h.engine, run.id);
      h.engine.start(run, h.profile);
      await entered.promise;
      expect(h.engine.pause(run.id)).toBe(true);
      release.resolve();
      expect((await paused).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      expect(h.database.getLatestCheckpoint(run.id)).toBeDefined();
      h.profile.generationPolicy = { maxOutputTokens: 2048, reviewMaxOutputTokens: 4096 };
      h.database.saveProfile(h.profile);
      const resumeOffset = h.requests.length;
      const resumed = nextResult(h.engine, run.id);
      h.engine.resume(run.id, h.profile);
      expect((await resumed).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      expect(h.requests.length).toBeGreaterThan(resumeOffset);
      expect(h.requests.slice(resumeOffset).every(request => request.maxOutputTokens === 6144)).toBe(true);
      expect(h.database.getRun(run.id)?.spec.generationPolicy).toEqual({ maxOutputTokens: 6144, reviewMaxOutputTokens: 8192 });
    } finally { release.resolve(); await h.close(); }
  });

  it("uses compatible defaults for legacy resumed runs without adopting newly edited Profile settings", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      h.database.saveRun(run, "paused");
      h.database.saveCheckpoint({ id: newId("checkpoint"), runId: run.id, sequence: 0, reason: "manual", status: "paused", transcript: [{ role: "user", content: [{ type: "text", text: run.request, trust: "user_request" }] }], usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, costKnown: true }, turns: 0, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso() });
      h.profile.generationPolicy = { maxOutputTokens: 2048, reviewMaxOutputTokens: 4096 };
      h.database.saveProfile(h.profile);
      const resumed = nextResult(h.engine, run.id);
      h.engine.resume(run.id, h.profile);
      expect((await resumed).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.map(request => request.maxOutputTokens)).toEqual([393216, 393216]);
      expect(h.database.getRun(run.id)?.spec).not.toHaveProperty("generationPolicy");
    } finally { await h.close(); }
  });

  it("inherits the active parent run settings for a delegated run after its Profile is edited", async () => {
    const entered = deferred(), release = deferred();
    let parentId = "";
    const h = await fixture(async (request, turn) => {
      if (request.runId === parentId && turn === 1) { entered.resolve(); await release.promise; }
    });
    try {
      const parent = h.spec();
      parentId = parent.id;
      const parentResult = nextResult(h.engine, parent.id);
      h.engine.start(parent, h.profile);
      await entered.promise;
      h.profile.generationPolicy = { maxOutputTokens: 16384, reviewMaxOutputTokens: 24576 };
      const child = h.spec({ parentRunId: parent.id });
      await h.finish(child);
      expect(h.requests.filter(request => request.runId === child.id).map(request => request.maxOutputTokens)).toEqual([6144, 6144]);
      expect(h.database.getRun(child.id)?.spec.generationPolicy).toEqual({ maxOutputTokens: 6144, reviewMaxOutputTokens: 8192 });
      release.resolve();
      expect((await parentResult).status).toBe("completed");
      await h.engine.waitForSettlement(parent.id);
    } finally { release.resolve(); await h.close(); }
  });
});
