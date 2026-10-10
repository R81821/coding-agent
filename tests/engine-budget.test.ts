import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

const temporary: string[] = [];
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

interface BudgetState {
  spec: RunSpec;
  turns: number;
  toolCalls: number;
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  costKnown: boolean;
  startedAt: number;
  elapsedBeforeStartMs?: number;
}
function activeBudgetState(engine: HarnessEngine, id: string): BudgetState {
  const state = (engine as unknown as { active: Map<string, BudgetState> }).active.get(id);
  if (!state) throw new Error("Budget fixture parent is no longer active");
  return state;
}

describe("delegate child budget aggregation", () => {
  async function build(maxUsd: number) {
    const root = await mkdtemp(join(tmpdir(), "harness-budget-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const model = descriptor({ providerId: "fake", modelId: "fake-budget-model", displayName: "Fake", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake",
      async listModels() { return [model]; },
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text_delta", delta: "done" };
      },
      async health() { return true; },
      estimateCost() { return 0; },
    };
    const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    resources.push(async () => { await engine.close(); database.close(); vault.dispose(); });
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
    const spec: RunSpec = { id: newId("run"), sessionId: "budget", request: "do", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxUsd }, grants: [], createdAt: nowIso() };
    const result = new Promise<AgentEvent>((resolveResult) => engine.on("event", (event: AgentEvent) => {
      if (event.type === "result") resolveResult(event);
    }));
    engine.start(spec, profile);
    return { engine, database, vault, spec, profile, result };
  }

  it("caps child budgets by the parent's remaining budget", async () => {
    const { engine, spec, result } = await build(10);
    const capped = engine.childBudget(spec.id, 2);
    expect(capped.maxUsd).toBeLessThanOrEqual(10 / 2);
    expect(capped.maxToolCalls).toBeGreaterThanOrEqual(1);
    expect(capped.maxDurationMs).toBeGreaterThanOrEqual(10_000);
    await result;
    await engine.waitForSettlement(spec.id);
  });

  it("reports child usage into the parent budget and rejects overage", async () => {
    const { engine, database, spec, result } = await build(5);
    engine.reportChildUsage(spec.id, { inputTokens: 100, outputTokens: 100, estimatedUsd: 1 });
    expect(() =>
      engine.reportChildUsage(spec.id, { inputTokens: 0, outputTokens: 0, estimatedUsd: 10 }),
    ).toThrow("Cost budget exceeded");
    expect(database.getLatestCheckpoint(spec.id)?.usage.estimatedUsd).toBe(11);
    await result;
    await engine.waitForSettlement(spec.id);
  });

  it("does not inflate small remaining child budgets with minimum floors", async () => {
    const { engine, spec } = await build(1);
    const parent = activeBudgetState(engine, spec.id);
    parent.spec.budget = { maxTurns: 13, maxToolCalls: 7, maxUsd: 0.005, maxDurationMs: 2000 };
    parent.turns = 10;
    parent.toolCalls = 5;
    parent.spentUsd = 0.003;
    parent.elapsedBeforeStartMs = 1500;
    parent.startedAt = Date.now();
    const budget = engine.childBudget(spec.id, 2);
    expect(budget.maxTurns).toBe(1);
    expect(budget.maxToolCalls).toBe(1);
    expect(budget.maxUsd).toBeCloseTo(0.001, 10);
    expect(budget.maxDurationMs).toBeGreaterThanOrEqual(1);
    expect(budget.maxDurationMs).toBeLessThanOrEqual(250);
    expect(budget.maxTurns * 2).toBeLessThanOrEqual(parent.spec.budget.maxTurns - parent.turns);
    expect(budget.maxToolCalls * 2).toBeLessThanOrEqual(parent.spec.budget.maxToolCalls - parent.toolCalls);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid child divisor %s", async divisor => {
    const { engine, spec } = await build(10);
    expect(() => engine.childBudget(spec.id, divisor)).toThrow(/divisor|positive integer/i);
  });

  it.each(["turns", "tools", "cost", "duration", "fractional-turn", "fractional-tool", "fractional-duration"] as const)("does not dispatch a child when %s cannot be allocated", async resource => {
    const { engine, spec, profile, events } = await buildWithEvents(10);
    const parent = activeBudgetState(engine, spec.id);
    parent.spec.budget = { maxTurns: 10, maxToolCalls: 10, maxUsd: 10, maxDurationMs: 60000 };
    parent.turns = 0;
    parent.toolCalls = 0;
    parent.spentUsd = 0;
    if (resource === "turns") parent.turns = 10;
    if (resource === "tools") parent.toolCalls = 10;
    if (resource === "cost") parent.spentUsd = 10;
    if (resource === "duration") parent.elapsedBeforeStartMs = 60001;
    if (resource === "fractional-turn") parent.turns = 9;
    if (resource === "fractional-tool") parent.toolCalls = 9;
    if (resource === "fractional-duration") { parent.elapsedBeforeStartMs = 59999; parent.startedAt = Date.now(); }
    let dispatched = false;
    expect(() => {
      const budget = engine.childBudget(spec.id, 2);
      dispatched = true;
      engine.start({ ...spec, id: newId("run_child"), parentRunId: spec.id, budget }, profile);
    }).toThrow();
    expect(dispatched).toBe(false);
    expect(events.some(event => event.runId !== spec.id && event.type === "status")).toBe(false);
  });

  async function buildWithEvents(maxUsd: number) {
    const fixture = await build(maxUsd);
    const events: AgentEvent[] = [];
    fixture.engine.on("event", event => events.push(event));
    return { ...fixture, events };
  }

  it("accumulates child turn and tool usage alongside tokens and cost", async () => {
    const { engine, database, spec } = await build(10);
    const parent = activeBudgetState(engine, spec.id);
    parent.spec.budget = { maxTurns: 5, maxToolCalls: 7, maxUsd: 10, maxDurationMs: 60000 };
    parent.turns = 1;
    parent.toolCalls = 2;
    engine.reportChildUsage(spec.id, { inputTokens: 11, outputTokens: 12, estimatedUsd: 0.1, turns: 2, toolCalls: 3 });
    engine.reportChildUsage(spec.id, { inputTokens: 13, outputTokens: 14, estimatedUsd: 0.2, turns: 1, toolCalls: 1, costKnown: false });
    expect(parent).toMatchObject({ turns: 4, toolCalls: 6, inputTokens: 24, outputTokens: 26, costKnown: false });
    expect(parent.spentUsd).toBeCloseTo(0.3);
    const budget = engine.childBudget(spec.id, 1);
    expect(budget.maxTurns).toBe(1);
    expect(budget.maxToolCalls).toBe(1);
    expect(budget.maxUsd).toBeCloseTo(9.7);
    expect(database.getLatestCheckpoint(spec.id)).toMatchObject({ turns: 4, toolCalls: 6, usage: { inputTokens: 24, outputTokens: 26, costKnown: false } });
    expect(database.getLatestCheckpoint(spec.id)?.usage.estimatedUsd).toBeCloseTo(0.3);
  });

  it.each(["turns", "tools"] as const)("records and synchronously rejects child %s overage", async resource => {
    const { engine, database, spec } = await build(10);
    const parent = activeBudgetState(engine, spec.id);
    parent.spec.budget = { maxTurns: 3, maxToolCalls: 3, maxUsd: 10, maxDurationMs: 60000 };
    parent.turns = 2;
    parent.toolCalls = 2;
    expect(() => engine.reportChildUsage(spec.id, { inputTokens: 1, outputTokens: 1, estimatedUsd: 0.1, ...(resource === "turns" ? { turns: 2 } : { toolCalls: 2 }) })).toThrow(/budget|轮次/i);
    expect(resource === "turns" ? parent.turns : parent.toolCalls).toBe(4);
    expect(parent.inputTokens).toBe(1);
    expect(parent.outputTokens).toBe(1);
    expect(parent.spentUsd).toBeCloseTo(0.1);
    const checkpoint = database.getLatestCheckpoint(spec.id)!;
    expect(resource === "turns" ? checkpoint.turns : checkpoint.toolCalls).toBe(4);
    expect(checkpoint.usage).toMatchObject({ inputTokens: 1, outputTokens: 1, estimatedUsd: 0.1 });
  });
});
