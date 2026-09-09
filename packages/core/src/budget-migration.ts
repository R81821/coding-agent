import { DEFAULT_PROFILE, type Profile } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";

const BUDGET_POLICY_VERSION = 1;

/** Load startup Profiles, persisting this policy once without touching RunSpec snapshots. */
export function loadProfilesWithBudgetMigration(database: Pick<HarnessDatabase, "listProfiles" | "saveProfile">): Map<string, Profile> {
  const profiles = new Map(database.listProfiles().map((profile) => [profile.id, profile]));
  if (!profiles.has(DEFAULT_PROFILE.id)) profiles.set(DEFAULT_PROFILE.id, DEFAULT_PROFILE);

  for (const [id, profile] of profiles) {
    // A version marker preserves later user edits and leaves newer policy versions intact.
    if ((profile.budgetPolicyVersion ?? 0) >= BUDGET_POLICY_VERSION) continue;
    const migrated: Profile = {
      ...profile,
      budgetPolicyVersion: BUDGET_POLICY_VERSION,
      budget: id === DEFAULT_PROFILE.id ? { ...profile.budget, maxToolCalls: 128, maxTurns: 64 } : profile.budget,
      verificationPolicy: { ...profile.verificationPolicy, maxRepairAttempts: null },
      resiliencePolicy: { ...profile.resiliencePolicy, maxToolSelfCorrections: null },
    };
    database.saveProfile(migrated);
    profiles.set(id, migrated);
  }
  return profiles;
}
