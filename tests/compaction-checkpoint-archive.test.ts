import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, nowIso, type AgentEvent, type ModelMessage, type RunCheckpoint, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

const sourceMarker = "EARLY_SOURCE_DETAIL_RETAINED_IN_ARCHIVE";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function compactedEngineRun(failCheckpoint?: "archive" | "summary" | "summary_write", pendingSteering = false) {
  const root = await mkdtemp(join(tmpdir(), "harness-compaction-archive-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const vault = await VaultCrypto.open(join(root, "key.json"), "archive-fixture-password");
  const databasePath = join(root, "state.sqlite");
  let database = await HarnessDatabase.open(databasePath, vault);
  cleanup.push(async () => {
    database.close();
    vault.dispose();
    const withinTemp = relative(tmpdir(), root);
    if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fixture"], toolNames: [] };
  const run: RunSpec = {
    id: "archive-run", sessionId: "archive-session", workflowVersion: 2, taskMode: "analysis",
    request: "Inspect the retained evidence and report the findings", workspacePath: workspace,
    profileId: profile.id, attachments: [], grants: [], createdAt: nowIso(), budget: profile.budget,
  };
  const transcript: ModelMessage[] = [
    { role: "user", content: [{ type: "text", trust: "user_request", text: run.request }] },
    ...Array.from({ length: 24 }, (_, index): ModelMessage => ({
      role: "assistant", content: [{ type: "text", trust: "untrusted_tool", text: `${index === 0 ? sourceMarker : "Historical observation " + index}\n${"x".repeat(10_000)}` }],
    })),
  ];
  const checkpoint: RunCheckpoint = {
    id: "archive-source-checkpoint", runId: run.id, sequence: 0, reason: "manual", status: "paused",
    transcript, usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, costKnown: true },
    turns: 0, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso(),
    ...(pendingSteering ? { pendingSteering: [{ id: "steering-compaction", text: "Preserve the original read-only scope." }] } : {}),
  };
  database.saveRun(run, "paused");
  database.saveCheckpoint(checkpoint);
  let rejectedArchive = false;
  if (failCheckpoint === "summary_write") {
    const encryptJson = vault.encryptJson.bind(vault);
    let compactionCheckpoints = 0;
    vault.encryptJson = (value, aad) => {
      if (aad?.startsWith("checkpoints:") && (value as Record<string, unknown>).reason === "compaction") compactionCheckpoints += 1;
      if (!rejectedArchive && compactionCheckpoints === 2 && aad?.startsWith("checkpoints:") && (value as Record<string, unknown>).reason === "compaction") {
        rejectedArchive = true;
        throw new Error("Compaction fixture disk failure");
      }
      return encryptJson(value, aad);
    };
  } else if (failCheckpoint) {
    const saveCheckpoint = database.saveCheckpoint.bind(database);
    let compactionCheckpoints = 0;
    database.saveCheckpoint = (saved, compaction, events) => {
      if (saved.reason === "compaction") compactionCheckpoints += 1;
      if (!rejectedArchive && compactionCheckpoints === (failCheckpoint === "archive" ? 1 : 2) && saved.reason === "compaction") {
        rejectedArchive = true;
        throw new Error("Compaction fixture disk failure");
      }
      saveCheckpoint(saved, compaction, events);
    };
  }
  const model = descriptor({ providerId: "fixture", modelId: "archive-model", displayName: "Archive model", maxContextTokens: 128_000 });
  const provider: ModelProvider = {
    id: "fixture", supportsNonThinkingCompaction: () => true, async listModels() { return [model]; },
    async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      yield { type: "text_delta" as const, delta: request.purpose === "compaction"
        ? JSON.stringify({ goal: run.request, constraints: pendingSteering ? ["Preserve the original read-only scope."] : [], decisions: [], evidence: [], completed: [], pending: [] })
        : "The retained evidence has been inspected." };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(async () => { await engine.close(); });
  const result = new Promise<Extract<AgentEvent, { type: "result" }>>(resolveResult => {
    engine.on("event", (event: AgentEvent) => { if (event.type === "result" && event.runId === run.id) resolveResult(event); });
  });
  engine.resume(run.id, profile);
  const outcome = await result;
  await engine.waitForSettlement(run.id);
  return {
    outcome, run, get rejectedArchive() { return rejectedArchive; }, get database() { return database; },
    async reopen() { database.close(); database = await HarnessDatabase.open(databasePath, vault); },
  };
}

describe("compaction source checkpoints", { timeout: 20_000 }, () => {
  it("acknowledges a steering message only after its compacted working context commits", async () => {
    const fixture = await compactedEngineRun(undefined, true);
    expect(fixture.outcome.status, fixture.outcome.text).toBe("completed");
    expect(fixture.database.getLatestCheckpoint(fixture.run.id)?.pendingSteering).toEqual([]);
    expect(fixture.database.listEvents(fixture.run.id).filter(event => event.type === "steering_delivered")).toHaveLength(1);
    expect(fixture.database.listCheckpoints(fixture.run.id, 100).some(checkpoint => checkpoint.transcript.some(message => message.steeringId === "steering-compaction"))).toBe(true);
  });

  it.each(["archive", "summary", "summary_write"] as const)("retains each correction once when compaction %s persistence fails", async failure => {
    const fixture = await compactedEngineRun(failure, true);
    expect(fixture.rejectedArchive).toBe(true);
    expect(fixture.outcome.text).toContain("Compaction fixture disk failure");
    await fixture.reopen();
    const saved = fixture.database.getLatestCheckpoint(fixture.run.id)!;
    const pending = saved.pendingSteering?.filter(message => message.id === "steering-compaction") ?? [];
    const retained = saved.transcript.filter(message => message.steeringId === "steering-compaction");
    // Failure can return pi's uncompressed transcript, which safely acknowledges the correction.
    // Otherwise it stays queued. Either recovery representation must contain exactly one message.
    expect(pending.length + retained.length).toBe(1);
    expect(pending.length ? pending[0]!.text : retained[0]!.content.find(part => part.type === "text")?.text).toBe("Preserve the original read-only scope.");
    expect(fixture.database.listEvents(fixture.run.id).filter(event => event.type === "steering_delivered")).toHaveLength(retained.length);
  });

  it("keeps the full pre-compaction source recoverable after database reopen", async () => {
    const fixture = await compactedEngineRun();
    expect(fixture.outcome.status, fixture.outcome.text).toBe("completed");
    await fixture.reopen();
    const checkpoints = fixture.database.listCheckpoints(fixture.run.id, 100);
    const compactionCheckpoints = checkpoints.filter(checkpoint => checkpoint.reason === "compaction");
    expect(compactionCheckpoints).toHaveLength(2);
    expect(compactionCheckpoints.some(checkpoint => JSON.stringify(checkpoint.transcript).includes(sourceMarker))).toBe(true);
    expect(compactionCheckpoints.some(checkpoint => !JSON.stringify(checkpoint.transcript).includes(sourceMarker))).toBe(true);
    expect(JSON.stringify(fixture.database.getLatestCheckpoint(fixture.run.id)!.transcript).includes(sourceMarker)).toBe(false);
    expect(fixture.database.listCompactions(fixture.run.id)).toHaveLength(1);
  });

  it("retains the original working transcript when source archival fails", async () => {
    const fixture = await compactedEngineRun("archive");
    expect(fixture.rejectedArchive).toBe(true);
    expect(fixture.outcome.text).toContain("Compaction fixture disk failure");
    expect(fixture.database.listCompactions(fixture.run.id)).toEqual([]);
    expect(JSON.stringify(fixture.database.getLatestCheckpoint(fixture.run.id)!.transcript).includes(sourceMarker)).toBe(true);
  });

  it.each(["summary", "summary_write"] as const)("retains the working transcript and source archive without an accepted record when %s checkpoint saving fails", async failure => {
    const fixture = await compactedEngineRun(failure);
    expect(fixture.rejectedArchive).toBe(true);
    expect(fixture.outcome.text).toContain("Compaction fixture disk failure");
    expect(fixture.database.listCompactions(fixture.run.id)).toEqual([]);
    expect(fixture.database.listCheckpoints(fixture.run.id, 100)
      .some(checkpoint => checkpoint.reason === "compaction" && JSON.stringify(checkpoint.transcript).includes(sourceMarker))).toBe(true);
    expect(JSON.stringify(fixture.database.getLatestCheckpoint(fixture.run.id)!.transcript).includes(sourceMarker)).toBe(true);
  });
});
