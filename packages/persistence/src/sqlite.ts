import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type BindParams, type Database, type SqlJsStatic, type Statement } from "sql.js";

const require = createRequire(import.meta.url);
let sqlitePromise: Promise<SqlJsStatic> | undefined;
const openPaths = new Set<string>();

const FLUSH_DEBOUNCE_MS = 500;

export class SQLiteFile {
  /** Number of full-database exports written to disk. Exposed for tests. */
  writeFlushes = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly path: string, private readonly database: Database) {}

  static async open(path: string): Promise<SQLiteFile> {
    if (openPaths.has(path)) throw new Error(`Database is locked by this process: ${path}`);
    const lockPath = `${path}.lock`;
    const existingPid = existsSync(lockPath) ? Number(readFileSync(lockPath, "utf8")) : NaN;
    if (!Number.isNaN(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
      throw new Error(`Database is locked by another process (pid ${existingPid}): ${path}`);
    }
    const colocatedWasm = join(dirname(fileURLToPath(import.meta.url)), "sql-wasm.wasm");
    sqlitePromise ??= initSqlJs({ locateFile: (file) => file.endsWith(".wasm") ? (existsSync(colocatedWasm) ? colocatedWasm : require.resolve("sql.js/dist/sql-wasm.wasm")) : file });
    const SQL = await sqlitePromise;
    const database = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    openPaths.add(path);
    return new SQLiteFile(path, database);
  }

  exec(sql: string): void {
    this.database.exec(sql);
    this.requestFlush();
  }

  prepare(sql: string): SQLiteStatement {
    return new SQLiteStatement(this.database, sql, () => this.requestFlush());
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
    this.database.close();
    openPaths.delete(this.path);
    rmSync(`${this.path}.lock`, { force: true });
  }

  private requestFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flush(): void {
    this.writeFlushes += 1;
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, Buffer.from(this.database.export()), { mode: 0o600 });
    renameSync(temporary, this.path);
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
  constructor(private readonly database: Database, private readonly sql: string, private readonly changed: () => void) {}

  run(...parameters: unknown[]): { changes: number } {
    this.database.run(this.sql, parameters as BindParams);
    this.changed();
    return { changes: this.database.getRowsModified() };
  }

  get(...parameters: unknown[]): Record<string, unknown> | undefined {
    const statement = this.bind(parameters);
    try { return statement.step() ? statement.getAsObject() : undefined; } finally { statement.free(); }
  }

  all(...parameters: unknown[]): Array<Record<string, unknown>> {
    const statement = this.bind(parameters);
    const rows: Array<Record<string, unknown>> = [];
    try { while (statement.step()) rows.push(statement.getAsObject()); } finally { statement.free(); }
    return rows;
  }

  private bind(parameters: unknown[]): Statement {
    const statement = this.database.prepare(this.sql);
    statement.bind(parameters as BindParams);
    return statement;
  }
}
