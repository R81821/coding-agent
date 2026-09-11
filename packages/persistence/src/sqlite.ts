import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  statSync,
  statfsSync,
} from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const openPaths = new Set<string>();

/**
 * A synchronous SQLite file backed by `node:sqlite` in WAL mode.
 *
 * This replaces the previous sql.js engine, which kept the whole database in memory and rewrote
 * every byte to disk on each flush (`database.export()` + `renameSync`). On a large database that
 * export is the entire file - hundreds of megabytes per checkpoint - and it is what killed the
 * daemon mid-run. WAL writes only the changed pages, so persistence cost is proportional to what
 * actually changed, and durability for each commit comes from SQLite rather than from a full copy.
 *
 * Every method stays synchronous, so `HarnessDatabase` keeps its public shape.
 */
export class SQLiteFile {
  /**
   * Explicit WAL checkpoints performed by this instance (folded back into the main file on close).
   * Exposed for tests: it must stay at 0 while writing, because no write path copies the database.
   */
  writeFlushes = 0;

  private constructor(
    private readonly path: string,
    private readonly database: DatabaseSync,
  ) {}

  static async open(
    path: string,
    migrate?: (database: SQLiteFile) => void,
  ): Promise<SQLiteFile> {
    path = resolve(path);
    if (openPaths.has(path))
      throw new Error(`Database is locked by this process: ${path}`);
    const lockPath = `${path}.lock`;
    // Exclusive creation closes the check/open race. Empty/malformed locks are never stolen:
    // another writer may be between its exclusive creation and its PID write.
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid))
        throw new Error(`Database is locked: ${path}`);
      // Rename the stale lock with exclusive ownership of reclamation, then retry once.
      const reclaim = `${lockPath}.reclaim`;
      try {
        writeFileSync(reclaim, String(process.pid), { flag: "wx" });
      } catch {
        throw new Error(`Database is locked during recovery: ${path}`);
      }
      try {
        if (Number(readFileSync(lockPath, "utf8")) !== pid)
          throw new Error("Database lock changed during recovery");
        rmSync(lockPath);
        writeFileSync(lockPath, String(process.pid), {
          flag: "wx",
          mode: 0o600,
        });
      } finally {
        rmSync(reclaim, { force: true });
      }
    }
    openPaths.add(path);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout=5000");
      const existing =
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all().length > 0;
      const old =
        Number(database.prepare("PRAGMA user_version").get()?.user_version) < 3;
      if (migrate && existing && old) {
        const disk = statfsSync(path);
        const bytes =
          statSync(path).size +
          (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
        if (disk.bavail * disk.bsize < Math.max(bytes * 4, 16 * 1024 * 1024))
          throw new Error("Insufficient free space for storage migration");
        const suffix = randomUUID(),
          backup = `${path}.pre-v3-${suffix}.bak`,
          stage = `${path}.stage-${suffix}`;
        // VACUUM INTO is a consistent SQLite snapshot including committed WAL pages.
        // It never touches the envelope or blobs. Backups are retained indefinitely.
        database.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        copyFileSync(backup, stage);
        const counts = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => {
            const name = String(row.name);
            return [
              name,
              database!
                .prepare(
                  `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
                )
                .get()?.n,
            ] as const;
          });
        let staged: DatabaseSync | undefined;
        try {
          staged = new DatabaseSync(stage);
          staged.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
          migrate(new SQLiteFile(stage, staged));
          if (
            staged.prepare("PRAGMA integrity_check").get()?.integrity_check !==
            "ok"
          )
            throw new Error("Storage migration integrity check failed");
          for (const [name, count] of counts) {
            const actual = staged
              .prepare(
                `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
              )
              .get()?.n;
            if (actual !== count && !["sessions", "projects"].includes(name))
              throw new Error(`Migration count mismatch: ${name}`);
            if (Number(actual) < Number(count))
              throw new Error(`Migration lost rows: ${name}`);
          }
          staged.close();
          staged = undefined;
          const checkpoint = database
            .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
            .get();
          if (Number(checkpoint?.busy ?? 0) !== 0)
            throw new Error(
              "Database is busy; migration left source and backup intact",
            );
          database.close();
          database = undefined;
          // A single rename replaces the closed source. Failure leaves the original intact;
          // a crash before/after this point leaves either the old or validated new DB.
          renameSync(stage, path);
          database = new DatabaseSync(path);
        } catch (error) {
          staged?.close();
          throw error;
        }
      }
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000",
      );
      const file = new SQLiteFile(path, database);
      if (migrate && !existing) migrate(file);
      return file;
    } catch (error) {
      database?.close();
      openPaths.delete(path);
      rmSync(lockPath, { force: true });
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SQLiteStatement {
    return new SQLiteStatement(this.database, sql);
  }

  close(): void {
    // Fold the write-ahead log back into the main file so a clean shutdown leaves one
    // self-contained database, and backups or copies never miss committed data.
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.writeFlushes += 1;
    } catch {
      /* the file is still recoverable from the log; closing matters more than the checkpoint */
    }
    this.database.close();
    openPaths.delete(this.path);
    rmSync(`${this.path}.lock`, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class SQLiteStatement {
  private readonly statement: StatementSync;

  constructor(database: DatabaseSync, sql: string) {
    this.statement = database.prepare(sql);
  }

  run(...parameters: unknown[]): { changes: number } {
    const result = this.statement.run(...(parameters.map(bindable) as never[]));
    return { changes: Number(result.changes) };
  }

  get(...parameters: unknown[]): Record<string, unknown> | undefined {
    return this.statement.get(...(parameters.map(bindable) as never[])) as
      Record<string, unknown> | undefined;
  }

  all(...parameters: unknown[]): Array<Record<string, unknown>> {
    return this.statement.all(
      ...(parameters.map(bindable) as never[]),
    ) as Array<Record<string, unknown>>;
  }
}

/** `node:sqlite` accepts a narrow set of parameter types; sql.js quietly turned undefined into null. */
function bindable(
  value: unknown,
): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  )
    return value;
  return String(value);
}
