import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, ProfileSchema, type Profile } from "@harness/protocol";
import { migrateFileToolsPolicy } from "../packages/core/src/file-tools-policy.js";

function oldProfile(overrides: Partial<Profile> = {}): Profile {
  const profile = ProfileSchema.parse({ ...DEFAULT_PROFILE, ...overrides });
  delete profile.fileToolsPolicyVersion;
  profile.toolNames = profile.toolNames.filter(name => name !== "write_file");
  return profile;
}

describe("built-in file tool availability migration", () => {
  it("enables write_file for an existing editor without rewriting user settings or run snapshots", () => {
    const old = oldProfile({ systemPrompt: "User configured prompt", allowedProviders: ["local"] });
    const snapshot = structuredClone(old);
    const profiles = new Map([[old.id, old]]);
    const database = { saveProfile: vi.fn() };
    migrateFileToolsPolicy(profiles, database);
    const current = profiles.get(old.id)!;
    expect(current.toolNames).toContain("write_file");
    expect(current).toEqual({ ...snapshot, toolNames: snapshot.toolNames.flatMap(name => name === "apply_patch" ? [name, "write_file"] : [name]), fileToolsPolicyVersion: 1 });
    expect(old).toEqual(snapshot);
    expect(database.saveProfile).toHaveBeenCalledOnce();
    migrateFileToolsPolicy(profiles, database);
    expect(database.saveProfile).toHaveBeenCalledOnce();
  });

  it("preserves a read-only default and custom profile tool lists", () => {
    const readOnly = oldProfile({ toolNames: ["read_file", "git_diff"] });
    const custom = oldProfile({ id: "restricted-editor", toolNames: ["read_file", "apply_patch"] });
    const profiles = new Map([[readOnly.id, readOnly], [custom.id, custom]]);
    migrateFileToolsPolicy(profiles, { saveProfile: vi.fn() });
    expect(profiles.get(readOnly.id)?.toolNames).toEqual(["read_file", "git_diff"]);
    expect(profiles.get(custom.id)).toBe(custom);
  });

  it.each([1, 2])("preserves later user tool restrictions at version %s", version => {
    const profile = { ...oldProfile(), fileToolsPolicyVersion: version };
    const profiles = new Map([[profile.id, profile]]);
    const database = { saveProfile: vi.fn() };
    migrateFileToolsPolicy(profiles, database);
    expect(profiles.get(profile.id)).toBe(profile);
    expect(database.saveProfile).not.toHaveBeenCalled();
  });
});
