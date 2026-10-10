import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface WorktreeLease {
  path: string;
  branch: string;
  cleanup(): Promise<void>;
}

export class WorktreeManager {
  constructor(private readonly managedRoot = join(tmpdir(), "harness-agent-worktrees")) {}

  async create(workspacePath: string, runId: string, taskId: string, signal: AbortSignal): Promise<WorktreeLease> {
    signal.throwIfAborted();
    await mkdir(this.managedRoot, { recursive: true });
    const managedRoot = await realpath(this.managedRoot);
    const workspace = await realpath(workspacePath);
    const root = await mkdtemp(join(managedRoot, "lease-"));
    const worktree = join(root, "workspace");
    const branch = `harness/${sanitize(runId)}/${sanitize(taskId)}/${basename(root)}`;
    let branchCreated = false;
    const cleanup = async () => {
      if (!within(managedRoot, root)) throw new Error("Refusing to remove an unmanaged worktree");
      const cleanupSignal = AbortSignal.timeout(30000);
      await git(workspace, ["worktree", "remove", "--force", worktree], cleanupSignal);
      if (branchCreated) await git(workspace, ["branch", "--delete", "--force", branch], cleanupSignal);
      await rm(root, { recursive: true, force: true });
    };
    try {
      await git(workspace, ["worktree", "add", "--detach", worktree, "HEAD"], signal);
      const patch = await git(workspace, ["diff", "--binary", "HEAD"], signal);
      if (patch.stdout.trim()) await git(worktree, ["apply", "--whitespace=nowarn", "-"], signal, patch.stdout);
      const untracked = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
      for (const relativePath of untracked.stdout.split("\0").filter(Boolean)) {
        signal.throwIfAborted();
        const source = resolve(workspace, relativePath);
        const target = resolve(worktree, relativePath);
        if (!within(workspace, source) || !within(worktree, target) || !within(workspace, await realpath(source))) throw new Error("Untracked path escapes the parent workspace");
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, errorOnExist: true });
      }
      branchCreated = true;
      await git(worktree, ["switch", "-c", branch], signal);
    } catch (error) {
      // An interrupted add may not yet be registered. All removal stays inside our lease root.
      await cleanup().catch(async () => {
        if (!within(managedRoot, root)) throw new Error("Refusing to remove an unmanaged worktree");
        await rm(root, { recursive: true, force: true });
      });
      throw error;
    }
    return {
      path: worktree,
      branch,
      cleanup,
    };
  }
}

export class ConcurrencyPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Sub-agent concurrency must be between 1 and 8");
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally { this.release(); }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise<void>((resolveWait, rejectWait) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort);
        resolveWait();
      };
      const abort = () => {
        const index = this.waiting.indexOf(resume);
        if (index >= 0) this.waiting.splice(index, 1);
        rejectWait(signal?.reason ?? new Error("Queued operation cancelled"));
      };
      this.waiting.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // Transfer ownership directly: newcomers must not steal a queued waiter's slot.
    if (next) next();
    else this.active -= 1;
  }
}

async function git(cwd: string, args: string[], signal: AbortSignal, stdin?: string): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", error => { signal.removeEventListener("abort", onAbort); reject(error); });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolveCommand({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
    child.stdin.end(stdin);
  });
}

function sanitize(value: string): string { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40); }

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
