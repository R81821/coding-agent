import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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

  private constructor(private readonly path: string, private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<SQLiteFile> {
    if (openPaths.has(path)) throw new Error(`Database is locked by this process: ${path}`);
    const lockPath = `${path}.lock`;
    const existingPid = existsSync(lockPath) ? Number(readFileSync(lockPath, "utf8")) : NaN;
    if (!Number.isNaN(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
      throw new Error(`Database is locked by another process (pid ${existingPid}): ${path}`);
    }
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");
    // WAL with NORMAL is crash-safe against a process crash (SQLite only risks the tail of the log
    // on power loss) and avoids an fsync per commit, which a per-tool-call write pattern would pay
    // thousands of times per run. The previous engine lost up to its 500ms debounce instead.
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    openPaths.add(path);
    return new SQLiteFile(path, database);
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
    // The sidecar files are SQLite's own; removing the leftovers keeps a closed database a single
    // file for callers that copy or back up the directory.
    for (const sidecar of [`${this.path}-wal`, `${this.path}-shm`]) {
      try {
        rmSync(sidecar, { force: true });
      } catch {
        /* still mapped on this platform: SQLite rebuilds it on the next open */
      }
    }
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
    return this.statement.get(...(parameters.map(bindable) as never[])) as Record<string, unknown> | undefined;
  }

  all(...parameters: unknown[]): Array<Record<string, unknown>> {
    return this.statement.all(...(parameters.map(bindable) as never[])) as Array<Record<string, unknown>>;
  }
}

/** `node:sqlite` accepts a narrow set of parameter types; sql.js quietly turned undefined into null. */
function bindable(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string" || value instanceof Uint8Array) return value;
  return String(value);
}
