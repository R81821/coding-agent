import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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

/** The marker records layout compatibility, never permission to reset an existing vault.
 * Checkpoint conversion happens after unlock in HarnessDatabase.open, using a staged SQLite
 * snapshot and the original encryption identity. No backup is ever automatically restored.
 */
export async function ensureV2Storage(
  appDataPath: string,
  legacyAppDataPaths: string[] = [],
): Promise<{ migrated: boolean; removed: string[] }> {
  const root = resolve(appDataPath);
  if (basename(root).length < 3 || dirname(root) === root)
    throw new Error(
      "Refusing v2 migration for an ambiguous application data path",
    );
  await mkdir(root, { recursive: true });
  const markerPath = join(root, SCHEMA_MARKER);
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      schema?: number;
    };
    if (marker.schema === 2) return { migrated: false, removed: [] };
    throw new Error("Unknown storage schema marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Do not silently initialize a new identity when another configured location holds history.
  if (!existsSync(join(root, "harness.sqlite"))) {
    const legacy = legacyAppDataPaths
      .map((path) => resolve(path))
      .find(
        (path) => path !== root && existsSync(join(path, "harness.sqlite")),
      );
    if (legacy)
      throw new Error(
        `Existing vault found at ${legacy}; open that data directory to preserve its database, envelope and blobs`,
      );
  }
  const temporaryMarker = join(root, `${SCHEMA_MARKER}.${randomUUID()}.tmp`);
  await writeFile(
    temporaryMarker,
    JSON.stringify({
      schema: 2,
      migratedAt: new Date().toISOString(),
      preservesIdentity: true,
    }),
    { encoding: "utf8", flag: "wx" },
  );
  await rename(temporaryMarker, markerPath);
  return { migrated: true, removed: [] };
}
export const v2StorageTargets = [...FIXED_V1_TARGETS];
