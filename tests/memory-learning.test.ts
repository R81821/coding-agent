import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { MemoryService } from "@harness/extensions";
import { DEFAULT_PROFILE, type Profile, type ModelRequest } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";
import { learnFromRun } from "../packages/core/src/memory-learning.js";
import { migrateMemoryPolicy } from "../packages/core/src/memory-policy.js";

describe("durable memory lifecycle", () => {
  let root: string, vault: VaultCrypto, database: HarnessDatabase, memory: MemoryService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memory-learning-"));
    vault = await VaultCrypto.open(join(root, "keys.json"), "test-password");
    database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    memory = new MemoryService(database);
  });
  afterEach(async () => { database?.close(); vault?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });
  const proposal = { content: "默认用中文回答", key: "response.language", kind: "preference" as const, scope: "global" as const, scopeId: "global", source: "run:1", confidence: .9 };

  it("enables global memory once while preserving custom scopes and subsequent opt-outs", () => {
    expect(DEFAULT_PROFILE.memoryScopes).toContain("global");
    const profiles = new Map<string, Profile>([
      ["legacy", { ...DEFAULT_PROFILE, id: "legacy", memoryScopes: ["session", "project"] }],
      ["disabled", { ...DEFAULT_PROFILE, id: "disabled", memoryScopes: [] }],
      ["custom", { ...DEFAULT_PROFILE, id: "custom", memoryScopes: ["project"] }],
    ]);
    migrateMemoryPolicy(profiles, database);
    expect(profiles.get("legacy")).toMatchObject({ memoryScopes: ["session", "project", "global"], memoryPolicyVersion: 1 });
    expect(profiles.get("disabled")?.memoryScopes).toEqual([]);
    expect(profiles.get("custom")?.memoryScopes).toEqual(["project"]);
    const saved = profiles.get("legacy")!;
    profiles.set("legacy", { ...saved, memoryScopes: ["session", "project"] });
    const save = vi.fn();
    migrateMemoryPolicy(profiles, { saveProfile: save });
    expect(save).not.toHaveBeenCalled();
    expect(profiles.get("legacy")?.memoryScopes).not.toContain("global");
  });

  it("merges repeated sources without resurrecting rejected memory or confusing language symbols", () => {
    const first = memory.propose(proposal);
    memory.decide(first.id, false, "user");
    expect(memory.propose({ ...proposal, source: "run:2" })).toMatchObject({ id: first.id, status: "rejected", sources: ["run:1", "run:2"] });
    expect(database.listMemories()).toHaveLength(1);
    const c = memory.propose({ ...proposal, content: "Use C" });
    const cpp = memory.propose({ ...proposal, content: "Use C++" });
    expect(c.id).not.toBe(cpp.id);
  });

  it("requires explicit conflict replacement and persists both sides atomically", async () => {
    const old = memory.propose(proposal);
    memory.decide(old.id, true, "user");
    const next = memory.propose({ ...proposal, content: "默认用英文回答", source: "run:2" });
    expect(next.conflictIds).toEqual([old.id]);
    expect(() => memory.decide(next.id, true, "user")).toThrow("冲突");
    memory.decide(next.id, true, "user", true);
    database.close(); database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    memory = new MemoryService(database);
    expect(memory.list().find(item => item.id === old.id)).toMatchObject({ status: "superseded", supersededBy: next.id });
    expect(memory.retrieve("unrelated", "new-session", "another-project", ["global"]).map(item => item.id)).toEqual([next.id]);
    expect(memory.propose(proposal).status).toBe("superseded");
  });

  it("recalls Chinese facts and applies project overrides before limiting a crowded result set", () => {
    memory.create({ content: "数据库使用事务保存订单", kind: "fact", key: "orders.storage", scope: "project", scopeId: root }, "user");
    expect(memory.retrieve("订单如何保存", "s", root, ["project"])).toHaveLength(1);
    const local = memory.create({ content: "本项目使用英文", kind: "convention", key: "response.language", scope: "project", scopeId: root }, "user");
    const global = memory.propose(proposal); memory.decide(global.id, true, "user");
    for (let i = 0; i < 40; i++) memory.create({ content: `Other preference ${i}`, kind: "preference", key: `other.${i}`, scope: "global", scopeId: "global" }, "user");
    const recalled = memory.retrieve("", "s", root, ["global", "project"], 60);
    expect(recalled.map(item => item.id)).toContain(local.id);
    expect(recalled.map(item => item.id)).not.toContain(global.id);
    expect(memory.retrieve("", "s", "other-project", ["global"], 60).map(item => item.id)).toContain(global.id);
    expect(memory.retrieve("", "s", root, [])).toEqual([]);
  });

  function learning(output: unknown, overrides: Partial<Parameters<typeof learnFromRun>[0]> = {}) {
    const model = descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake", capabilities: { tools: true, vision: false, structuredOutput: true, parallelTools: false, maxContextTokens: 32000, dataPolicy: "local" } });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream(request) { requests.push(request); yield { type: "text_delta", delta: typeof output === "string" ? output : JSON.stringify(output) }; yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10, estimatedUsd: 0 } }; },
    };
    const beforeRequest = vi.fn(), onUsage = vi.fn(), onFinished = vi.fn();
    return { requests, beforeRequest, onUsage, onFinished, promise: learnFromRun({
      runId: "run-learning", workspacePath: root, userMessages: ["以后所有项目默认用中文回答。本项目使用 pnpm。"], outcome: "数据库采用 SQLite。", verified: true,
      scopes: ["global", "project"], memory, provider, model, signal: new AbortController().signal, remainingUsd: 1,
      beforeRequest, onUsage, onFinished, ...overrides,
    }) };
  }

  it("extracts only grounded candidates, isolates scopes and accounts for the model request", async () => {
    const entry = { content: "默认用中文回答", key: "response.language", kind: "preference", scope: "global", sourceIndex: 0, quote: "以后所有项目默认用中文回答" };
    const result = learning({ memories: [entry,
      { ...entry, content: "invented", quote: "not in the source" },
      { ...entry, content: "assistant preference", sourceIndex: 1, quote: "数据库采用 SQLite。" },
      { ...entry, content: "数据库采用 SQLite。", kind: "fact", scope: "project", key: "database", sourceIndex: 1, quote: "数据库采用 SQLite。" },
      { ...entry, content: "本项目使用 pnpm", kind: "convention", scope: "project", key: "package.manager", quote: "本项目使用 pnpm" },
    ] });
    expect(await result.promise).toHaveLength(3);
    expect(database.listMemories().every(item => item.status === "candidate" && item.evidence?.length === 1)).toBe(true);
    expect(memory.retrieve("", "s", root, ["project", "global"])).toEqual([]);
    expect(result.requests[0]).toMatchObject({ purpose: "memory", store: false, tools: [] });
    expect(result.beforeRequest).toHaveBeenCalledTimes(1);
    expect(result.onUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "memory", inputTokens: 20 }));
    expect(result.onFinished).toHaveBeenCalledTimes(1);
    const disabled = learning({ memories: [entry] }, { scopes: ["session"] });
    expect(await disabled.promise).toEqual([]); expect(disabled.requests).toEqual([]);
    expect(await learning({ memories: [entry] }, { scopes: ["project"] }).promise).toEqual([]);
  });

  it("does not save malformed output or unsupported outcome facts", async () => {
    await expect(learning("invalid-json").promise).rejects.toThrow();
    expect(database.listMemories()).toEqual([]);
    expect(await learning({ memories: [{ content: "SQLite", key: "database", kind: "fact", scope: "project", sourceIndex: 1, quote: "数据库采用 SQLite。" }] }, { verified: false }).promise).toEqual([]);
    expect(database.listMemories()).toEqual([]);
  });

  it("skips extraction when the remaining cost budget cannot cover a request", async () => {
    const model = descriptor({ providerId: "expensive", modelId: "expensive", displayName: "Expensive", capabilities: { tools: false, vision: false, structuredOutput: true, parallelTools: false, maxContextTokens: 32000, dataPolicy: "local" } });
    const stream = vi.fn();
    const result = learning({ memories: [] }, { model, remainingUsd: .01, provider: {
      id: "expensive", listModels: async () => [model], health: async () => true, estimateCost: () => 1, stream,
    } });
    expect(await result.promise).toEqual([]);
    expect(result.beforeRequest).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});
