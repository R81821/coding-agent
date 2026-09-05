import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface WorktreeLease {
  path: string;
  branch: string;
  cleanup(): Promise<void>;
}

export class WorktreeManager {
  constructor(private readonly managedRoot = join(tmpdir(), "harness-agent-worktrees")) {}

  async create(workspacePath: string, runId: string, taskId: string, signal: AbortSignal): Promise<WorktreeLease> {
    await mkdir(this.managedRoot, { recursive: true });
    const root = await mkdtemp(join(this.managedRoot, "lease-"));
    const worktree = join(root, "workspace");
    const branch = `harness/${sanitize(runId)}/${sanitize(taskId)}`;
    await git(workspacePath, ["worktree", "add", "--detach", worktree, "HEAD"], signal);
    const patch = await git(workspacePath, ["diff", "--binary", "HEAD"], signal);
    if (patch.stdout.trim()) await git(worktree, ["apply", "--whitespace=nowarn", "-"], signal, patch.stdout);
    const untracked = await git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
    for (const relativePath of untracked.stdout.split("\0").filter(Boolean)) {
      const source = resolve(workspacePath, relativePath);
      const target = resolve(worktree, relativePath);
      if (!source.startsWith(resolve(workspacePath)) || !target.startsWith(resolve(worktree))) continue;
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, errorOnExist: true });
    }
    await git(worktree, ["switch", "-c", branch], signal);
    return {
      path: worktree,
      branch,
      cleanup: async () => {
        const resolved = resolve(root);
        if (!resolved.startsWith(resolve(this.managedRoot))) throw new Error("Refusing to remove an unmanaged worktree");
        await git(workspacePath, ["worktree", "remove", "--force", worktree], AbortSignal.timeout(30_000));
        await rm(root, { recursive: true, force: true });
      }
    };
  }
}

export class ConcurrencyPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit = 4) {
    if (limit < 1 || limit > 8) throw new Error("Sub-agent concurrency must be between 1 and 8");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await operation(); } finally { this.release(); }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise<void>((resolveWait) => this.waiting.push(resolveWait));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

async function git(cwd: string, args: string[], signal: AbortSignal, stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolveCommand({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
    child.stdin.end(stdin);
  });
}

function sanitize(value: string): string { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40); }
