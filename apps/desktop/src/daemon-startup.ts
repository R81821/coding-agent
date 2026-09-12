export function daemonStartupError(stderr: string, exitCode: number | null): Error {
  if (/Invalid application passphrase or corrupted key envelope/i.test(stderr)) {
    return new Error("应用口令错误，或本地密钥文件已损坏。请使用创建此加密库时的口令。");
  }
  const explicit = [...stderr.matchAll(/^Error:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  if (explicit) return new Error(`daemon 启动失败：${explicit}`);
  return new Error(`daemon 启动失败${exitCode === null ? "" : `（退出码 ${exitCode}）`}。请查看桌面生命周期日志。`);
}

export function appendBounded(current: string, chunk: string, maxLength = 16_384): string {
  const combined = current + chunk;
  return combined.length <= maxLength ? combined : combined.slice(-maxLength);
}

const PROGRESS_PREFIX = "HARNESS_STARTUP_PROGRESS:";
const MAX_PROGRESS_LINE = 4_096;
const NORMAL_STARTUP_MS = 30_000;
const MIGRATION_STALL_MS = 5 * 60_000;
const MIGRATION_TOTAL_MS = 30 * 60_000;
const STARTUP_STAGES = ["unlocking", "storage_open", "storage_backup", "storage_copy", "storage_migrate", "storage_validate", "storage_switch", "runtime_ready"] as const;
export interface DaemonStartupProgress {
  stage: typeof STARTUP_STAGES[number];
  completed?: number;
  total?: number;
}

function parseProgress(line: string): DaemonStartupProgress | undefined {
  if (!line.startsWith(PROGRESS_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(PROGRESS_PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (!STARTUP_STAGES.includes(item.stage as DaemonStartupProgress["stage"])) return undefined;
    if (Object.keys(item).some(key => !["stage", "completed", "total"].includes(key))) return undefined;
    for (const key of ["completed", "total"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || item[key] < 0)) return undefined;
    }
    if (typeof item.completed === "number" && typeof item.total === "number" && item.completed > item.total) return undefined;
    return { stage: item.stage as DaemonStartupProgress["stage"], ...(item.completed === undefined ? {} : { completed: item.completed as number }), ...(item.total === undefined ? {} : { total: item.total as number }) };
  } catch { return undefined; }
}

/** Only validated, advancing migration work extends startup, with an absolute budget. */
export class DaemonStartupMonitor {
  private readonly startedAt: number;
  private lastAdvanceAt: number;
  private migrationStarted = false;
  private readonly completedByStage = new Map<string, number>();
  private partialLine = "";
  private discardingLine = false;
  private errorTail = "";
  failure: Error | undefined;
  progress: DaemonStartupProgress | undefined;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.lastAdvanceAt = this.startedAt;
  }

  get expired(): boolean {
    const now = this.now();
    return this.migrationStarted
      ? now - this.startedAt >= MIGRATION_TOTAL_MS || now - this.lastAdvanceAt >= MIGRATION_STALL_MS
      : now - this.startedAt >= NORMAL_STARTUP_MS;
  }

  consume(chunk: string): DaemonStartupProgress[] {
    if (!this.failure && /Invalid application passphrase or corrupted key envelope/i.test(this.errorTail + chunk)) {
      this.failure = daemonStartupError("Invalid application passphrase or corrupted key envelope", null);
    }
    this.errorTail = appendBounded(this.errorTail, chunk, 256);
    const accepted: DaemonStartupProgress[] = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const stop = end < 0 ? chunk.length : end;
      if (!this.discardingLine) {
        if (this.partialLine.length + stop - start > MAX_PROGRESS_LINE) {
          this.partialLine = "";
          this.discardingLine = true;
        } else this.partialLine += chunk.slice(start, stop);
      }
      if (end < 0) break;
      if (!this.discardingLine) {
        const progress = parseProgress(this.partialLine.replace(/\r$/, ""));
        if (progress) {
          accepted.push(progress);
          if (!this.expired && !this.failure) this.observe(progress);
        }
      }
      this.partialLine = "";
      this.discardingLine = false;
      start = end + 1;
    }
    return accepted;
  }

  private observe(progress: DaemonStartupProgress): void {
    this.progress = progress;
    if (!progress.stage.startsWith("storage_")) return;
    const previous = this.completedByStage.get(progress.stage);
    const completed = progress.completed ?? -1;
    if (previous === undefined || completed > previous) {
      this.completedByStage.set(progress.stage, completed);
      this.migrationStarted = true;
      this.lastAdvanceAt = this.now();
    }
  }

  diagnostics(): Record<string, unknown> {
    return { elapsedMs: this.now() - this.startedAt, stalledMs: this.now() - this.lastAdvanceAt, migrationStarted: this.migrationStarted, progress: this.progress };
  }

  timeoutError(): Error {
    if (this.failure) return this.failure;
    if (this.migrationStarted) {
      const reason = this.now() - this.startedAt >= MIGRATION_TOTAL_MS ? "已达到 30 分钟启动等待上限" : "连续 5 分钟未收到新的迁移进度";
      return new Error("旧库迁移尚未完成：" + reason + "。原库和已创建的备份会保留，请查看桌面生命周期日志中的迁移阶段与进度，再重试启动。");
    }
    return new Error("daemon 在 30 秒内未建立通信管道，也未报告有效的旧库迁移进度。详情已写入桌面生命周期日志。");
  }
}
