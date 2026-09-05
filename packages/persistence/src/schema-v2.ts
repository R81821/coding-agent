import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SCHEMA_MARKER = "schema-v2.marker";
const FIXED_V1_TARGETS = [
  "harness.sqlite",
  "harness.sqlite-shm",
  "harness.sqlite-wal",
  "blobs",
  "worktrees",
  "traces",
  "key-envelope.json",
  "device-unlock.bin",
] as const;

export async function ensureV2Storage(appDataPath: string, legacyAppDataPaths: string[] = []): Promise<{ migrated: boolean; removed: string[] }> {
  const root = resolve(appDataPath);
  if (basename(root).length < 3 || dirname(root) === root) throw new Error("Refusing v2 migration for an ambiguous application data path");
  await mkdir(root, { recursive: true });
  const markerPath = join(root, SCHEMA_MARKER);
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { schema?: number };
    if (marker.schema === 2) return { migrated: false, removed: [] };
    throw new Error("Unknown storage schema marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const roots = [...new Set([root, ...legacyAppDataPaths.map((path) => resolve(path))])];
  const removed: string[] = [];
  // v1 data is moved into a timestamped backup directory instead of being
  // deleted outright; the key envelope is the only way back into the vault.
  const backupDir = join(root, "backup", `v1-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let backupCreated = false;
  for (const candidateRoot of roots) {
    if (basename(candidateRoot).length < 3 || dirname(candidateRoot) === candidateRoot) throw new Error("Refusing v2 migration for an ambiguous legacy data path");
    for (const name of FIXED_V1_TARGETS) {
      const target = resolve(candidateRoot, name);
      if (dirname(target) !== candidateRoot || relative(candidateRoot, target) !== name) throw new Error(`Unsafe v2 migration target: ${target}`);
      if (!existsSync(target)) continue;
      if (!backupCreated) {
        await mkdir(backupDir, { recursive: true });
        backupCreated = true;
      }
      await rename(target, join(backupDir, name));
      removed.push(target);
    }
  }
  if (backupCreated) {
    const backups = (await readdir(join(root, "backup")).catch(() => [] as string[]))
      .filter((entry) => entry.startsWith("v1-"))
      .sort();
    for (const entry of backups.slice(0, -3)) await rm(join(root, "backup", entry), { recursive: true, force: true });
  }
  const temporaryMarker = join(root, `${SCHEMA_MARKER}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryMarker, JSON.stringify({ schema: 2, migratedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
  await rename(temporaryMarker, markerPath);
  return { migrated: true, removed };
}

export const v2StorageTargets = [...FIXED_V1_TARGETS];
