import { DEFAULT_PROFILE, type Profile } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";

/** Upgrade the built-in editor once; read-only/custom tool restrictions and historical runs stay intact. */
export function migrateFileToolsPolicy(profiles: Map<string, Profile>, database: Pick<HarnessDatabase, "saveProfile">): void {
  const profile = profiles.get(DEFAULT_PROFILE.id);
  if (!profile || (profile.fileToolsPolicyVersion ?? 0) >= 1) return;
  const enabled = profile.toolNames.includes("apply_patch") && !profile.toolNames.includes("write_file");
  const toolNames = enabled ? profile.toolNames.flatMap(name => name === "apply_patch" ? [name, "write_file"] : [name]) : profile.toolNames;
  const migrated = { ...profile, toolNames, fileToolsPolicyVersion: 1 };
  database.saveProfile(migrated);
  profiles.set(profile.id, migrated);
}
