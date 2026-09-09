import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_PROFILE, ProfileSchema, RunBudgetSchema, type Profile, type RunSpec } from "@harness/protocol";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { loadProfilesWithBudgetMigration } from "../packages/core/src/budget-migration.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function oldProfile(id = "default"): Profile {
  return ProfileSchema.parse({
    ...DEFAULT_PROFILE,
    id,
    name: "Custom configuration",
    systemPrompt: "Preserve this prompt",
    allowedProviders: ["openai-compatible"],
    preferredModels: ["custom-model"],
    routeWeights: { quality: 0.2, cost: 0.7, latency: 0.1 },
    toolNames: ["read_file", "terminal"],
    skillIds: ["custom-skill"],
    sandbox: "docker",
    budget: { maxTurns: 24, maxToolCalls: 64, maxDurationMs: 90_000, maxUsd: 1.25 },
    verificationPolicy: { broaderPolicy: "optional", reviewPolicy: "risk_based", items: [{ id: "check", command: "npm test" }], maxRepairAttempts: 2 },
    resiliencePolicy: { maxProviderAttempts: 5, providerRetryBaseDelayMs: 123, maxToolSelfCorrections: 3 },
    detailedRemoteOutput: true,
  });
}

function store(initial: Profile[]) {
  const profiles = new Map(initial.map((profile) => [profile.id, structuredClone(profile)]));
  return {
    listProfiles: () => [...profiles.values()],
    saveProfile: vi.fn((profile: Profile) => { profiles.set(profile.id, ProfileSchema.parse(profile)); }),
  };
}

describe("runtime Profile budget migration", () => {
  it("migrates default once while preserving every unrelated configuration field", () => {
    const previous = oldProfile();
    const database = store([previous]);
    const migrated = loadProfilesWithBudgetMigration(database).get("default");
    expect(migrated).toEqual({
      ...previous,
      budgetPolicyVersion: 1,
      budget: { ...previous.budget, maxToolCalls: 128, maxTurns: 64 },
      verificationPolicy: { ...previous.verificationPolicy, maxRepairAttempts: null },
      resiliencePolicy: { ...previous.resiliencePolicy, maxToolSelfCorrections: null },
    });
    expect(previous.budget).toMatchObject({ maxTurns: 24, maxToolCalls: 64 });
    expect(previous.verificationPolicy.maxRepairAttempts).toBe(2);
    expect(database.saveProfile).toHaveBeenCalledTimes(1);
    expect(loadProfilesWithBudgetMigration(database).get("default")).toEqual(migrated);
    expect(database.saveProfile).toHaveBeenCalledTimes(1);
  });

  it("preserves custom Profile run budgets and removes both recovery limits", () => {
    const custom = oldProfile("custom");
    custom.budget = { ...custom.budget, maxTurns: 80, maxToolCalls: 175 };
    const database = store([custom]);
    expect(loadProfilesWithBudgetMigration(database).get(custom.id)).toEqual({
      ...custom,
      budgetPolicyVersion: 1,
      verificationPolicy: { ...custom.verificationPolicy, maxRepairAttempts: null },
      resiliencePolicy: { ...custom.resiliencePolicy, maxToolSelfCorrections: null },
    });
  });

  it("creates the built-in default with the migration already recorded", () => {
    const database = store([]);
    expect(loadProfilesWithBudgetMigration(database).get("default")).toEqual({ ...DEFAULT_PROFILE, budgetPolicyVersion: 1 });
    loadProfilesWithBudgetMigration(database);
    expect(database.saveProfile).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])("does not overwrite later user edits at policy version %s", (version) => {
    const edited = { ...oldProfile(), budgetPolicyVersion: version };
    edited.budget = { ...edited.budget, maxTurns: 15, maxToolCalls: 40 };
    const database = store([edited]);
    expect(loadProfilesWithBudgetMigration(database).get("default")).toEqual(edited);
    expect(database.saveProfile).not.toHaveBeenCalled();
  });

  it("accepts old numeric policies and uses expanded defaults only when omitted", () => {
    const previous = oldProfile();
    expect(ProfileSchema.parse(previous)).toEqual(previous);
    expect(previous.budgetPolicyVersion).toBeUndefined();
    expect(RunBudgetSchema.parse(previous.budget)).toEqual(previous.budget);
    expect(RunBudgetSchema.parse({})).toEqual({ maxTurns: 64, maxToolCalls: 128, maxDurationMs: 1_800_000, maxUsd: 5 });
  });

  it("persists the marker across database reopens and leaves historical run snapshots unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-profile-migration-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "test-passphrase");
    const path = join(root, "harness.sqlite");
    let database = await HarnessDatabase.open(path, vault);
    try {
      const previous = oldProfile();
      const run: RunSpec = { id: "historical", sessionId: "session", request: "old request", workspacePath: root, profileId: previous.id, budget: { ...previous.budget }, attachments: [], grants: [], createdAt: new Date().toISOString() };
      database.saveProfile(previous);
      database.saveRun(run, "completed");
      const migrated = loadProfilesWithBudgetMigration(database).get("default")!;
      database.close();
      database = await HarnessDatabase.open(path, vault);
      expect(database.listProfiles()[0]).toEqual(migrated);
      const edited = { ...migrated, budget: { ...migrated.budget, maxTurns: 33, maxToolCalls: 99 } };
      database.saveProfile(edited);
      database.close();
      database = await HarnessDatabase.open(path, vault);
      expect(loadProfilesWithBudgetMigration(database).get("default")).toEqual(edited);
      expect(database.getRun(run.id)?.spec).toEqual(run);
    } finally {
      database.close();
      vault.dispose();
    }
  });
});
