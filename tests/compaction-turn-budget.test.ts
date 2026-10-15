import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, nowIso, type AgentEvent, type ModelMessage, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

it("reports reserved-turn compaction refusal as a model turn budget stop and preserves raw history", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-compaction-turn-budget-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const vault = await VaultCrypto.open(join(root, "key.json"), "budget-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  let engine: HarnessEngine | undefined;
  try {
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fixture"], toolNames: [], budget: { ...DEFAULT_PROFILE.budget, maxTurns: 2 } };
    const run: RunSpec = {
      id: "compaction-turn-budget", sessionId: "compaction-turn-budget", workflowVersion: 2, taskMode: "analysis",
      request: "Inspect the retained history.", workspacePath: workspace, profileId: profile.id,
      attachments: [], grants: [], createdAt: nowIso(), budget: profile.budget,
    };
    const transcript: ModelMessage[] = [
      { role: "user", content: [{ type: "text", trust: "user_request", text: run.request }] },
      ...Array.from({ length: 24 }, (_, index): ModelMessage => ({ role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `IMPORTANT_SOURCE_${index}: ` + "x".repeat(10_000) }] })),
    ];
    database.saveRun(run, "paused");
    database.saveCheckpoint({ id: "compaction-turn-source", runId: run.id, sequence: 0, reason: "manual", status: "paused", transcript,
      usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, costKnown: true }, turns: 0, toolCalls: 0,
      pendingNonIdempotentToolCalls: [], createdAt: nowIso() });
    const model = descriptor({ providerId: "fixture", modelId: "budget", displayName: "Budget", maxContextTokens: 128_000 });
    let requests = 0;
    const provider: ModelProvider = {
      id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream() { requests += 1; yield { type: "text_delta" as const, delta: "No request should dispatch." }; },
    };
    engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const result = new Promise<Extract<AgentEvent, { type: "result" }>>(resolveResult => {
      engine!.on("event", (event: AgentEvent) => { if (event.type === "result" && event.runId === run.id) resolveResult(event); });
    });
    engine.resume(run.id, profile);
    const outcome = await result;
    await engine.waitForSettlement(run.id);
    expect(requests).toBe(0);
    expect(JSON.stringify(database.getLatestCheckpoint(run.id)!.transcript)).toContain("IMPORTANT_SOURCE_0");
    expect(outcome.status).toBe("review");
    expect(outcome.stop?.code).toBe("model_turn_limit");
  } finally {
    await engine?.close();
    database.close();
    vault.dispose();
    const withinTemp = relative(tmpdir(), root);
    if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});
