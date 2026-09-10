import { afterEach, describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EncryptedBlobStore,
  ensureV2Storage,
  HarnessDatabase,
  SQLiteFile,
  VaultCrypto,
} from "@harness/persistence";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("key envelope atomic write and backup", () => {
  it("restores a corrupted envelope from the .bak mirror", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-envelope-bak-"));
    temporary.push(root);
    const path = join(root, "key-envelope.json");
    const vault = await VaultCrypto.open(path, "correct-password");
    vault.dispose();
    expect(existsSync(`${path}.bak`)).toBe(true);
    await writeFile(path, "{corrupted json", "utf8");
    const reopened = await VaultCrypto.open(path, "correct-password");
    reopened.dispose();
    const restored = JSON.parse(await readFile(path, "utf8")) as { version?: number };
    expect(restored.version).toBe(1);
  });
});

describe("v2 storage migration backs up v1 data instead of deleting it", () => {
  it("moves v1 targets into backup/v1-* and keeps marker idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-schema-v2-"));
    temporary.push(root);
    await writeFile(join(root, "harness.sqlite"), "old-db", "utf8");
    await writeFile(join(root, "key-envelope.json"), "{}", "utf8");
    const first = await ensureV2Storage(root);
    expect(first.migrated).toBe(true);
    expect(existsSync(join(root, "harness.sqlite"))).toBe(false);
    expect(existsSync(join(root, "key-envelope.json"))).toBe(false);
    const backups = await readdir(join(root, "backup"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^v1-/);
    expect(await readFile(join(root, "backup", backups[0]!, "harness.sqlite"), "utf8")).toBe("old-db");
    expect(existsSync(join(root, "schema-v2.marker"))).toBe(true);
    const second = await ensureV2Storage(root);
    expect(second.migrated).toBe(false);
  });
});

describe("incremental writes instead of whole-database exports", () => {
  it("does not copy the database while writing and folds the log back on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-flush-"));
    temporary.push(root);
    const path = join(root, "harness.sqlite");
    const database = await SQLiteFile.open(path);
    const before = database.writeFlushes;
    for (let index = 0; index < 50; index += 1) {
      database.prepare("CREATE TABLE IF NOT EXISTS t (id INTEGER)").run();
      database.prepare("INSERT INTO t (id) VALUES (?)").run(index);
    }
    // The sql.js engine rewrote the entire file on a debounce timer; WAL appends changed pages and
    // keeps the main file untouched, which is what makes this safe on a large database.
    expect(database.writeFlushes - before).toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(true);
    database.close();
    expect(database.writeFlushes - before).toBe(1);
    expect(existsSync(path)).toBe(true);
    // A clean shutdown checkpoints the log away entirely, so the single file carries every row.
    const log = `${path}-wal`;
    expect(existsSync(log) ? statSync(log).size : 0).toBe(0);
  });
});

describe("blob store path containment", () => {
  it("rejects attachments whose encryptedPath escapes the blob root", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-blob-root-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const store = new EncryptedBlobStore(join(root, "blobs"), vault);
    const ref = await store.put({ bytes: Buffer.from("hello"), mimeType: "image/png", source: "file" });
    await writeFile(join(root, "outside.txt"), "secret", "utf8");
    await expect(store.read({ ...ref, encryptedPath: join(root, "outside.txt") })).rejects.toThrow("escapes");
    vault.dispose();
  });
});

describe("sqlite single-writer lock", () => {
  it("rejects a second open of the same database until the first closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-db-lock-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const path = join(root, "harness.sqlite");
    const first = await HarnessDatabase.open(path, vault);
    await expect(HarnessDatabase.open(path, vault)).rejects.toThrow("locked");
    first.close();
    const second = await HarnessDatabase.open(path, vault);
    second.close();
    vault.dispose();
  });
});
