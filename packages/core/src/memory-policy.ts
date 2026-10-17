import type { Profile } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";

/** Upgrade the former default once; later choices (including disabling memory) survive restart. */
export function migrateMemoryPolicy(profiles: Map<string, Profile>, database: Pick<HarnessDatabase, "saveProfile">): void {
  for (const [id, profile] of profiles) {
    if ((profile.memoryPolicyVersion ?? 0) >= 1) continue;
    const oldDefault = profile.memoryScopes.length === 2 && profile.memoryScopes.includes("session") && profile.memoryScopes.includes("project");
    const updated: Profile = { ...profile, memoryPolicyVersion: 1, memoryScopes: oldDefault ? ["session", "project", "global"] : profile.memoryScopes };
    database.saveProfile(updated);
    profiles.set(id, updated);
  }
}
