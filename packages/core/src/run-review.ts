import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunReview, RunReviewFile } from "@harness/protocol";
import type { VaultCrypto } from "@harness/persistence";

export interface ReviewRun {
  id: string;
  sessionId: string;
  workspacePath: string;
}
interface StoredFile extends RunReviewFile {
  fingerprint: string;
  indexFingerprint: string;
}
interface StoredReview extends RunReview {
  sessionId: string;
  workspacePath: string;
  repositoryRoot?: string;
  baselineTree?: string;
  files: StoredFile[];
}
interface ReviewChecks {
  getRun?: (runId: string) => ReviewRun | undefined;
  activeRuns?: () => ReviewRun[];
  activeWorkspaces?: () => string[];
}

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
/** Ignored untracked files (including node_modules and local secrets) are intentionally excluded. */
const REVIEW_SCOPE = "tracked-and-nonignored-untracked" as const;
const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** A per-run Git-tree delta captured with a disposable index; the user's index is never staged. */
export class RunReviewService {
  private readonly active = new Map<string, string>();
  private readonly contaminated = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly invalidatedRuns = new Set<string>();
  private readonly pendingSaves = new Set<Promise<void>>();
  private readonly repositoryLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly crypto: VaultCrypto,
    private readonly checks: ReviewChecks = {},
  ) {}

  async begin(run: ReviewRun, resumed = false): Promise<void> {
    const prior = await this.load(run.id);
    const root =
      prior?.repositoryRoot ?? (await this.repositoryRoot(run.workspacePath));
    if (!root) return this.beginLocked(run, resumed);
    return this.withRepositoryLock(root, () => this.beginLocked(run, resumed));
  }

  private async beginLocked(run: ReviewRun, resumed: boolean): Promise<void> {
    const previous = await this.load(run.id);
    if (previous) {
      if (
        previous.sessionId !== run.sessionId ||
        !samePath(previous.workspacePath, run.workspacePath)
      )
        throw new Error("Review run identity changed");
      if (resumed && previous.status === "ready") {
        previous.status = "capturing";
        previous.files = [];
        delete previous.reason;
        await this.save(previous);
      }
      if (previous.status === "capturing" && previous.repositoryRoot)
        await this.claim(previous);
      return;
    }
    const record: StoredReview = {
      runId: run.id,
      sessionId: run.sessionId,
      workspacePath: resolve(run.workspacePath),
      status: "capturing",
      files: [],
    };
    try {
      const repositoryRoot = (
        await git(run.workspacePath, ["rev-parse", "--show-toplevel"])
      )
        .toString("utf8")
        .trim();
      const inside = relative(
        resolve(repositoryRoot),
        resolve(run.workspacePath),
      );
      if (inside.startsWith("..") || isAbsolute(inside))
        throw new Error("Workspace is outside Git repository");
      record.repositoryRoot = resolve(repositoryRoot);
      await this.save(record);
      if (!(await this.claim(record))) return;
      const tree = await snapshot(record.repositoryRoot);
      const latest = await this.load(run.id);
      if (latest?.status === "unavailable" || this.contaminated.has(run.id))
        return;
      record.baselineTree = tree;
    } catch (error) {
      record.status = "unavailable";
      record.reason = error instanceof Error ? error.message : String(error);
    }
    await this.save(record);
  }

  private async claim(record: StoredReview): Promise<boolean> {
    const repositoryRoot = record.repositoryRoot;
    if (!repositoryRoot) return false;
    const overlapping = [...this.active]
      .filter(
        ([id, root]) => id !== record.runId && samePath(root, repositoryRoot),
      )
      .map(([id]) => id);
    for (const other of this.checks.activeRuns?.() ?? []) {
      if (other.id === record.runId || overlapping.includes(other.id)) continue;
      try {
        const root = (
          await git(other.workspacePath, ["rev-parse", "--show-toplevel"])
        )
          .toString("utf8")
          .trim();
        if (samePath(root, repositoryRoot)) overlapping.push(other.id);
      } catch {
        /* A non-Git active workspace cannot share this repository. */
      }
    }
    this.active.set(record.runId, repositoryRoot);
    const paused = await this.capturingInRepository(
      repositoryRoot,
      record.runId,
    );
    if (!overlapping.length && !paused.length) return true;
    const reason = "Concurrent or intervening run in the same repository";
    for (const id of [...new Set([...overlapping, ...paused, record.runId])]) {
      this.contaminated.add(id);
      await this.markUnavailable(id, reason);
    }
    return false;
  }

  async finish(runId: string, paused: boolean): Promise<void> {
    const prior = await this.load(runId);
    if (!prior?.repositoryRoot) return this.finishLocked(runId, paused);
    return this.withRepositoryLock(prior.repositoryRoot, () =>
      this.finishLocked(runId, paused),
    );
  }

  private async finishLocked(runId: string, paused: boolean): Promise<void> {
    try {
      const record = await this.load(runId);
      if (!record || record.status !== "capturing" || paused) return;
      try {
        if (!record.repositoryRoot || !record.baselineTree)
          throw new Error("Git baseline is missing");
        const endTree = await snapshot(record.repositoryRoot);
        const names = (
          await git(record.repositoryRoot, [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            record.baselineTree,
            endTree,
          ])
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        const files: StoredFile[] = [];
        for (const path of names) {
          validatePath(record.repositoryRoot, path);
          const diff = (
            await git(record.repositoryRoot, [
              "diff",
              "--binary",
              "--no-renames",
              "--full-index",
              record.baselineTree,
              endTree,
              "--",
              path,
            ])
          ).toString("utf8");
          const numstat = (
            await git(record.repositoryRoot, [
              "diff",
              "--numstat",
              "--no-renames",
              record.baselineTree,
              endTree,
              "--",
              path,
            ])
          )
            .toString("utf8")
            .split("\t");
          files.push({
            path,
            added: Number(numstat[0]) || 0,
            deleted: Number(numstat[1]) || 0,
            diff,
            canUndo: true,
            undone: false,
            fingerprint: await fileFingerprint(record.repositoryRoot, path),
            indexFingerprint: await indexFingerprint(
              record.repositoryRoot,
              path,
            ),
          });
        }
        record.files = files;
        record.status = "ready";
      } catch (error) {
        record.status = "unavailable";
        record.files = [];
        record.reason = error instanceof Error ? error.message : String(error);
      }
      if (this.contaminated.has(runId)) {
        record.status = "unavailable";
        record.files = [];
        record.reason = "Concurrent or intervening run in the same repository";
      }
      await this.save(record);
    } finally {
      this.active.delete(runId);
      this.contaminated.delete(runId);
    }
  }

  async get(runId: string): Promise<RunReview> {
    const record = await this.load(runId);
    if (!record)
      return {
        runId,
        status: "unavailable",
        files: [],
        reason: "No review record",
        scope: REVIEW_SCOPE,
      };
    return this.publicReview(record);
  }

  async undo(runId: string, path: string): Promise<RunReview> {
    const prior = await this.load(runId);
    if (!prior?.repositoryRoot) throw new Error("Review is not ready for undo");
    return this.withRepositoryLock(prior.repositoryRoot, () =>
      this.undoLocked(runId, path),
    );
  }

  private async undoLocked(runId: string, path: string): Promise<RunReview> {
    const record = await this.load(runId);
    if (!record || record.status !== "ready" || !record.repositoryRoot)
      throw new Error("Review is not ready for undo");
    const run = this.checks.getRun?.(runId);
    if (
      this.checks.getRun &&
      (!run ||
        run.sessionId !== record.sessionId ||
        !samePath(run.workspacePath, record.workspacePath))
    )
      throw new Error("Run or workspace no longer matches review");
    const file = record.files.find((item) => item.path === path);
    if (!file || !file.canUndo || file.undone)
      throw new Error("File is not available for undo");
    validatePath(record.repositoryRoot, path);
    const currentRoot = (
      await git(record.workspacePath, ["rev-parse", "--show-toplevel"])
    )
      .toString("utf8")
      .trim();
    if (!samePath(currentRoot, record.repositoryRoot))
      throw new Error("Workspace repository changed");
    const otherWorkspaces = this.checks.activeWorkspaces?.() ?? [];
    for (const workspace of otherWorkspaces) {
      try {
        const root = (await git(workspace, ["rev-parse", "--show-toplevel"]))
          .toString("utf8")
          .trim();
        if (samePath(root, record.repositoryRoot))
          throw new Error("Active run in repository");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Active run in repository"
        )
          throw error;
      }
    }
    if (
      [...this.active.values()].some((root) =>
        samePath(root, record.repositoryRoot!),
      )
    )
      throw new Error("Active run in repository");
    if (
      (await fileFingerprint(record.repositoryRoot, path)) !== file.fingerprint
    )
      throw new Error("File changed after run; undo conflicts");
    if (
      (await indexFingerprint(record.repositoryRoot, path)) !==
      file.indexFingerprint
    )
      throw new Error("Staged state changed after run; undo conflicts");
    await git(
      record.repositoryRoot,
      ["apply", "-R", "--binary", "--check", "-"],
      file.diff,
    );
    if (
      (await fileFingerprint(record.repositoryRoot, path)) !==
        file.fingerprint ||
      (await indexFingerprint(record.repositoryRoot, path)) !==
        file.indexFingerprint
    )
      throw new Error("File or staged state changed during undo");
    await git(
      record.repositoryRoot,
      ["apply", "-R", "--binary", "-"],
      file.diff,
    );
    file.undone = true;
    file.canUndo = false;
    await this.save(record);
    return this.publicReview(record);
  }

  private async repositoryRoot(
    workspacePath: string,
  ): Promise<string | undefined> {
    try {
      return (await git(workspacePath, ["rev-parse", "--show-toplevel"]))
        .toString("utf8")
        .trim();
    } catch {
      return undefined;
    }
  }

  private async withRepositoryLock<T>(
    root: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key =
      process.platform === "win32"
        ? resolve(root).toLowerCase()
        : resolve(root);
    const previous = this.repositoryLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.repositoryLocks.set(key, current);
    if (previous) await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.repositoryLocks.get(key) === current)
        this.repositoryLocks.delete(key);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    await Promise.allSettled([...this.pendingSaves]);
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((name) => name.endsWith(".review"))) {
      const target = join(this.root, name);
      const record = this.crypto.decryptJson<StoredReview>(
        await readFile(target, "utf8"),
        "run-review-v1",
      );
      if (record.sessionId === sessionId) {
        this.invalidatedRuns.add(record.runId);
        await rm(target);
      }
    }
  }

  restoreSession(sessionId: string): void {
    this.deletedSessions.delete(sessionId);
  }

  private publicReview(record: StoredReview): RunReview {
    return {
      runId: record.runId,
      status: record.status,
      scope: REVIEW_SCOPE,
      files: record.files.map(
        ({ path, added, deleted, diff, canUndo, undone }) => ({
          path,
          added,
          deleted,
          diff,
          canUndo,
          undone,
        }),
      ),
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }
  private filePath(runId: string): string {
    return join(this.root, `${digest(runId)}.review`);
  }
  private async load(runId: string): Promise<StoredReview | undefined> {
    try {
      const record = this.crypto.decryptJson<StoredReview>(
        await readFile(this.filePath(runId), "utf8"),
        "run-review-v1",
      );
      if (record.runId !== runId) throw new Error("Review identity mismatch");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async save(record: StoredReview): Promise<void> {
    if (
      this.deletedSessions.has(record.sessionId) ||
      this.invalidatedRuns.has(record.runId)
    )
      return;
    const pending = (async () => {
      await mkdir(this.root, { recursive: true });
      const temporary = join(
        this.root,
        `${digest(record.runId)}.${randomUUID()}.tmp`,
      );
      await writeFile(
        temporary,
        this.crypto.encryptJson(record, "run-review-v1"),
        { mode: 0o600 },
      );
      await rename(temporary, this.filePath(record.runId));
    })();
    this.pendingSaves.add(pending);
    try {
      await pending;
    } finally {
      this.pendingSaves.delete(pending);
    }
  }
  private async markUnavailable(runId: string, reason: string): Promise<void> {
    const record = await this.load(runId);
    if (!record) return;
    record.status = "unavailable";
    record.reason = reason;
    record.files = [];
    await this.save(record);
  }
  private async capturingInRepository(
    repositoryRoot: string,
    exceptRunId: string,
  ): Promise<string[]> {
    const names = await readdir(this.root);
    const matches: string[] = [];
    for (const name of names.filter((name) => name.endsWith(".review"))) {
      const record = this.crypto.decryptJson<StoredReview>(
        await readFile(join(this.root, name), "utf8"),
        "run-review-v1",
      );
      if (
        record.runId !== exceptRunId &&
        record.status === "capturing" &&
        record.repositoryRoot &&
        samePath(record.repositoryRoot, repositoryRoot)
      )
        matches.push(record.runId);
    }
    return matches;
  }
}

function validatePath(root: string, path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("Invalid review path");
  const rel = relative(root, resolve(root, path));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Review path escapes repository");
}

async function fileFingerprint(root: string, path: string): Promise<string> {
  validatePath(root, path);
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory())
        throw new Error("Review path parent is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return "missing-parent";
      throw error;
    }
  }
  const target = join(root, ...parts);
  try {
    const stat = await lstat(target);
    const content = stat.isSymbolicLink()
      ? Buffer.from(await readlink(target))
      : stat.isFile()
        ? await readFile(target)
        : Buffer.from("not-a-file");
    return digest(
      Buffer.concat([
        Buffer.from(
          `${stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "other"}:${stat.mode & 0o111}:`,
        ),
        content,
      ]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function indexFingerprint(root: string, path: string): Promise<string> {
  return digest(await git(root, ["ls-files", "--stage", "-z", "--", path]));
}

async function snapshot(root: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "run-review-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
  try {
    const realIndex = (await git(root, ["rev-parse", "--git-path", "index"]))
      .toString("utf8")
      .trim();
    try {
      await copyFile(resolve(root, realIndex), env.GIT_INDEX_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git(root, ["read-tree", "--empty"], undefined, env);
    }
    await git(root, ["add", "-A", "--", "."], undefined, env);
    return (await git(root, ["write-tree"], undefined, env))
      .toString("utf8")
      .trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function git(
  cwd: string,
  args: string[],
  input?: string,
  env = process.env,
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveResult(Buffer.concat(out))
        : reject(
            new Error(
              `git ${args[0]} failed: ${Buffer.concat(errors).toString("utf8").trim()}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
}
