import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureV2Storage,
  HarnessDatabase,
  VaultCrypto,
} from "@harness/persistence";
import {
  DEFAULT_PROFILE,
  nowIso,
  type MemoryRecord,
  type Profile,
} from "@harness/protocol";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("encrypted persistence", () => {
  it("persists a legacy context policy migration once, retaining the backup across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-policy-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
    const path = join(root, "harness.sqlite");
    let database = await HarnessDatabase.open(path, vault);
    const legacy = { ...DEFAULT_PROFILE, contextPolicy: { ...DEFAULT_PROFILE.contextPolicy, compactAtRatio: .7, maxAfterCompactionRatio: .8 } };
    // Seed the old on-disk format directly: new writes intentionally reject this policy.
    (database as unknown as { upsert(table: string, id: string, value: unknown): void }).upsert("profiles", legacy.id, legacy);
    expect(() => database.saveProfile(legacy)).toThrow();
    const migrated = database.listProfiles()[0]!;
    expect(migrated.contextPolicy).toMatchObject({ compactAtRatio: .8, maxAfterCompactionRatio: .45 });
    expect(migrated.contextPolicyMigration?.previous).toEqual(legacy.contextPolicy);
    database.close();
    database = await HarnessDatabase.open(path, vault);
    expect(database.listProfiles()[0]).toEqual(migrated);
    database.close(); vault.dispose();
  });
  it("rejects a wrong application passphrase", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-vault-test-"));
    temporary.push(root);
    const envelope = join(root, "key-envelope.json");
    const vault = await VaultCrypto.open(envelope, "correct-password");
    vault.dispose();
    await expect(
      VaultCrypto.open(envelope, "incorrect-password"),
    ).rejects.toThrow(/Invalid application passphrase/);
  });

  it("round-trips encrypted records and searches memory without plaintext indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-db-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(
      join(root, "key-envelope.json"),
      "correct-password",
    );
    const database = await HarnessDatabase.open(
      join(root, "harness.sqlite"),
      vault,
    );
    const legacyProfile = { ...DEFAULT_PROFILE } as Partial<Profile>;
    delete legacyProfile.resiliencePolicy;
    database.saveProfile(legacyProfile as Profile);
    const memory: MemoryRecord = {
      id: "memory-1",
      content: "The project uses a deterministic permission engine",
      source: "test",
      scope: "project",
      scopeId: "project-1",
      confidence: 0.9,
      status: "approved",
      pinned: false,
      approvedBy: "tester",
      createdAt: nowIso(),
    };
    database.saveMemory(memory);
    expect(database.listProfiles()[0]).toMatchObject({
      id: "default",
      resiliencePolicy: {
        maxProviderAttempts: 3,
        providerRetryBaseDelayMs: 500,
        maxToolSelfCorrections: null,
      },
    });
    expect(
      database.searchMemories("permission engine", ["project-1"]),
    ).toMatchObject([{ id: "memory-1" }]);
    database.close();
    vault.dispose();
  });

  it("marks v2 compatibility without clearing history and preserves provider settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-v2-reset-test-"));
    temporary.push(root);
    await writeFile(join(root, "harness.sqlite"), "v1", "utf8");
    await writeFile(join(root, "key-envelope.json"), "v1", "utf8");
    await mkdir(join(root, "blobs"));
    await writeFile(join(root, "blobs", "old"), "ciphertext", "utf8");
    await writeFile(join(root, "provider-settings.json"), "preserve", "utf8");
    const first = await ensureV2Storage(root);
    expect(first.migrated).toBe(true);
    expect(await readFile(join(root, "harness.sqlite"), "utf8")).toBe("v1");
    expect(await readFile(join(root, "provider-settings.json"), "utf8")).toBe(
      "preserve",
    );
    await writeFile(join(root, "harness.sqlite"), "v2", "utf8");
    expect(await ensureV2Storage(root)).toMatchObject({
      migrated: false,
      removed: [],
    });
    expect(await readFile(join(root, "harness.sqlite"), "utf8")).toBe("v2");
  });
});
