import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, ProfileSchema, migrateContextPolicy } from "@harness/protocol";

describe("context policy migration", () => {
  it("rejects a target at or above the trigger on new profile writes", () => {
    for (const target of [0.7, 0.8]) expect(ProfileSchema.safeParse({ ...DEFAULT_PROFILE, contextPolicy: { ...DEFAULT_PROFILE.contextPolicy, compactAtRatio: 0.7, maxAfterCompactionRatio: target } }).success).toBe(false);
  });
  it("migrates legacy settings once and retains the original settings", () => {
    const old = { ...DEFAULT_PROFILE, contextPolicy: { ...DEFAULT_PROFILE.contextPolicy, compactAtRatio: 0.7, maxAfterCompactionRatio: 0.8 } };
    const migrated = ProfileSchema.parse(migrateContextPolicy(old));
    expect(migrated.contextPolicy).toMatchObject({ compactAtRatio: 0.8, maxAfterCompactionRatio: 0.45 });
    expect(migrated.contextPolicyMigration).toMatchObject({ version: 1, reason: "legacy_defaults", previous: old.contextPolicy });
    expect(migrateContextPolicy(migrated)).toEqual(migrated);
    expect(old.contextPolicy.maxAfterCompactionRatio).toBe(0.8);
  });
  it("keeps valid custom settings, and records invalid custom settings before normalization", () => {
    const valid = { ...DEFAULT_PROFILE, contextPolicy: { ...DEFAULT_PROFILE.contextPolicy, compactAtRatio: 0.65, maxAfterCompactionRatio: 0.35 } };
    expect(migrateContextPolicy(valid)).toEqual(valid);
    const invalid = { ...valid, contextPolicy: { ...valid.contextPolicy, maxAfterCompactionRatio: 0.7 } };
    const normalized = ProfileSchema.parse(migrateContextPolicy(invalid));
    expect(normalized.contextPolicy.compactAtRatio).toBe(0.65);
    expect(normalized.contextPolicy.maxAfterCompactionRatio).toBeLessThan(0.65);
    expect(normalized.contextPolicyMigration?.reason).toBe("invalid_saved_config");
  });
});
