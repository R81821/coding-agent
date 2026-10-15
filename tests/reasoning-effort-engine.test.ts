import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type Profile, type ReasoningEffort, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function nextResult(engine: HarnessEngine, runId: string) {
  return new Promise<Extract<AgentEvent, { type: "result" }>>(resolve => {
    const listener = (event: AgentEvent) => { if (event.runId === runId && event.type === "result") { engine.off("event", listener); resolve(event); } };
    engine.on("event", listener);
  });
}
async function fixture(beforeRequest?: (request: ModelRequest, turn: number) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "model-choice-workspace-")), state = await mkdtemp(join(tmpdir(), "model-choice-state-"));
  const vault = await VaultCrypto.open(join(state, "key.json"), "model-choice-password");
  const dbPath = join(state, "db.sqlite");
  let database = await HarnessDatabase.open(dbPath, vault);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const requests: ModelRequest[] = [], turns = new Map<string, number>();
  const providers: ModelProvider[] = ["chosen", "better"].map(id => {
    const model = descriptor({ providerId: id, modelId: "same-model", displayName: id, qualityScore: id === "chosen" ? 0.1 : 1,
      capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local", reasoningEfforts: ["low", "high", "max"] } });
    return { id, listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const turn = (turns.get(request.runId) ?? 0) + 1; turns.set(request.runId, turn);
        requests.push(structuredClone(request)); await beforeRequest?.(request, turn);
        const hasRead = request.messages.some(message => message.content.some(part => part.type === "tool_result" && part.toolCallId.startsWith("choice-read-")));
        if (!hasRead) yield { type: "tool_call", toolCall: { id: `choice-read-${turn}`, name: "read_file", input: { path: "source.ts" } } };
        else yield { type: "text_delta", delta: "source.ts exports value = 1." };
      } };
  });
  const engine = new HarnessEngine({ database, providers, tools: new ToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(state, "skills")), projectTrust: new ProjectTrustService(database) });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: providers.map(provider => provider.id), toolNames: ["read_file"] };
  const choice: ReasoningEffort = "high";
  const at = nowIso();
  database.createSession({ id: "session-choice", workspacePath: workspace, profileId: profile.id, title: "Choice", createdAt: at, updatedAt: at, reasoningEffort: choice });
  const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({ id: newId("run"), sessionId: "session-choice", request: "Analyze source.ts", workspacePath: workspace, profileId: profile.id,
    budget: { ...profile.budget, maxTurns: 8 }, workflowVersion: 2, taskMode: "analysis", attachments: [], grants: [], createdAt: nowIso(), ...overrides });
  const finish = async (run: RunSpec) => { const done = nextResult(engine, run.id); engine.start(run, profile); const event = await done; await engine.waitForSettlement(run.id); expect(event.status, event.text).toBe("completed"); return event; };
  return { engine, get database() { return database; }, profile, choice, requests, spec, finish,
    async reopen() { await engine.close(); database.close(); database = await HarnessDatabase.open(dbPath, vault); },
    async close() { await engine.close(); database.close(); vault.dispose(); await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

describe("persisted independent reasoning selection", { timeout: 20000 }, () => {
  it("freezes the session effort and sends it on real main requests without changing the model", async () => {
    const h = await fixture();
    try {
      const run = h.spec(); await h.finish(run);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.every(request => request.model.providerId === "better" && request.reasoningEffort === "high" && request.purpose === "main")).toBe(true);
      expect(h.database.getRun(run.id)?.spec.reasoningEffort).toEqual(h.choice);
      expect(run.reasoningEffort).toBeUndefined();
      await h.reopen();
      expect(h.database.getSessionDetail(run.sessionId)?.session.reasoningEffort).toEqual(h.choice);
      expect(h.database.getRun(run.id)?.spec.reasoningEffort).toEqual(h.choice);
    } finally { await h.close(); }
  });

  it("preserves an explicit provider default instead of inheriting the session effort", async () => {
    const h = await fixture();
    try {
      const run = h.spec({ reasoningEffort: null }); await h.finish(run);
      expect(h.requests.every(request => request.model.providerId === "better" && request.reasoningEffort === undefined)).toBe(true);
      expect(h.database.getRun(run.id)?.spec.reasoningEffort).toBeNull();
      h.database.touchSession(run.sessionId, { reasoningEffort: null });
      await h.reopen(); expect(h.database.getSessionDetail(run.sessionId)?.session.reasoningEffort).toBeNull();
    } finally { await h.close(); }
  });

  it("keeps active and resumed choices while the next run uses the changed selection", async () => {
    const entered = deferred(), release = deferred(); let firstId = "";
    const h = await fixture(async (request, turn) => { if (request.runId === firstId && turn === 1) { entered.resolve(); await release.promise; } });
    try {
      const first = h.spec(); firstId = first.id; const done = nextResult(h.engine, first.id); h.engine.start(first, h.profile); await entered.promise;
      h.database.touchSession(first.sessionId, { reasoningEffort: "low" });
      expect(h.engine.pause(first.id)).toBe(true); release.resolve(); expect((await done).status).toBe("paused"); await h.engine.waitForSettlement(first.id);
      const resumed = nextResult(h.engine, first.id); h.engine.resume(first.id, h.profile); expect((await resumed).status).toBe("completed"); await h.engine.waitForSettlement(first.id);
      expect(h.requests.filter(request => request.runId === first.id).every(request => request.model.providerId === "better" && request.reasoningEffort === "high")).toBe(true);
      const next = h.spec(); await h.finish(next);
      expect(h.requests.filter(request => request.runId === next.id).every(request => request.model.providerId === "better" && request.reasoningEffort === "low")).toBe(true);
    } finally { release.resolve(); await h.close(); }
  });

  it("inherits the active parent's frozen selection ahead of a changed session", async () => {
    const entered = deferred(), release = deferred(); let parentId = "";
    const h = await fixture(async (request, turn) => { if (request.runId === parentId && turn === 1) { entered.resolve(); await release.promise; } });
    try {
      const parent = h.spec(); parentId = parent.id; const done = nextResult(h.engine, parent.id); h.engine.start(parent, h.profile); await entered.promise;
      h.database.touchSession(parent.sessionId, { reasoningEffort: "low" });
      const child = h.spec({ parentRunId: parent.id }); await h.finish(child);
      expect(h.database.getRun(child.id)?.spec.reasoningEffort).toEqual(h.choice);
      expect(h.requests.filter(request => request.runId === child.id).every(request => request.model.providerId === "better" && request.reasoningEffort === "high")).toBe(true);
      release.resolve(); await done; await h.engine.waitForSettlement(parent.id);
    } finally { release.resolve(); await h.close(); }
  });

  it("continues unfinished work with its original choice after the session changes", async () => {
    const h = await fixture();
    try {
      const previous = h.spec({ reasoningEffort: h.choice });
      h.database.saveRun(previous, "review");
      h.database.saveCheckpoint({ id: newId("checkpoint"), runId: previous.id, sequence: 0, reason: "manual", status: "review", transcript: [{ role: "user", content: [{ type: "text", text: previous.request, trust: "user_request" }] }], usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }, turns: 8, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso() });
      h.database.appendEvent({ id: newId("event"), runId: previous.id, sequence: 0, at: nowIso(), type: "result", status: "review", text: "unfinished", stop: { code: "model_turn_limit", message: "budget", phase: "understand", pending: ["Analyze source.ts"], usage: { toolCalls: { used: 0, limit: 128 }, modelTurns: { used: 8, limit: 8 }, repairs: { used: 0, limit: null }, usd: { used: 0, limit: 5 }, durationMs: { used: 0, limit: 10000 } } } });
      h.database.touchSession(previous.sessionId, { reasoningEffort: null });
      const nextId = h.engine.continueRun(previous.id, h.profile); const event = await nextResult(h.engine, nextId); await h.engine.waitForSettlement(nextId);
      expect(event.status, event.text).toBe("completed");
      expect(h.database.getRun(nextId)?.spec.reasoningEffort).toEqual(h.choice);
      expect(h.requests.filter(request => request.runId === nextId).every(request => request.model.providerId === "better" && request.reasoningEffort === "high")).toBe(true);
    } finally { await h.close(); }
  });
});
