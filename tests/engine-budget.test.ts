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
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

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
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
    const spec: RunSpec = { id: newId("run"), sessionId: "budget", request: "do", workspacePath: root, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxUsd }, grants: [], createdAt: nowIso() };
    const result = new Promise<AgentEvent>((resolveResult) => engine.on("event", (event: AgentEvent) => {
      if (event.type === "result") resolveResult(event);
    }));
    engine.start(spec, profile);
    return { engine, database, vault, spec, result };
  }

  it("caps child budgets by the parent's remaining budget", async () => {
    const { engine, database, vault, spec, result } = await build(10);
    const capped = engine.childBudget(spec.id, 2);
    expect(capped.maxUsd).toBeLessThanOrEqual(10 / 2);
    expect(capped.maxToolCalls).toBeGreaterThanOrEqual(1);
    expect(capped.maxDurationMs).toBeGreaterThanOrEqual(10_000);
    await result;
    database.close();
    vault.dispose();
  });

  it("reports child usage into the parent budget and rejects overage", async () => {
    const { engine, database, vault, spec, result } = await build(5);
    engine.reportChildUsage(spec.id, { inputTokens: 100, outputTokens: 100, estimatedUsd: 1 });
    expect(() =>
      engine.reportChildUsage(spec.id, { inputTokens: 0, outputTokens: 0, estimatedUsd: 10 }),
    ).toThrow("Cost budget exceeded");
    await result;
    database.close();
    vault.dispose();
  });
});
