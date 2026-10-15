import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GraphExecutionTask {
  id: string;
  prompt: string;
  mode: "read" | "write";
  stepId?: string;
  /** Relative files/directories owned by this task. Omission means an unknown write scope. */
  writePaths?: string[];
}

export type GraphTaskOutcome<T> =
  | { taskId: string; status: "fulfilled"; value: T }
  | { taskId: string; status: "rejected"; error: unknown };

export interface GraphTaskExecutionOptions {
  /** Only enable when writes use separate workspaces. Shared-workspace writes are exclusive. */
  allowParallelWrites?: boolean;
}

function normalizedWritePaths(task: GraphExecutionTask): string[] | undefined {
  if (task.mode === "read" || !task.writePaths?.length) return undefined;
  return task.writePaths.map(path => {
    const slashes = path.replaceAll("\\", "/").toLowerCase();
    if (!slashes || slashes.startsWith("/") || /^[a-z]:/.test(slashes) || slashes.split("/").includes("..")) {
      throw new Error(`Task ${task.id} has an invalid workspace-relative write path`);
    }
    const normalized = slashes.split("/").filter(part => part && part !== ".").join("/") || ".";
    // A glob cannot prove independence without examining the complete matched file set.
    return /[*?[\]{}]/.test(normalized) ? "." : normalized;
  });
}

function overlap(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return true;
  return left.some(a => right.some(b => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function graphTasksCompatible(left: GraphExecutionTask, right: GraphExecutionTask, isolatedWrites = false): boolean {
  if (left.mode === "read" && right.mode === "read") return true;
  if (!isolatedWrites) return false;
  return left.mode === "read" || right.mode === "read" || !overlap(normalizedWritePaths(left), normalizedWritePaths(right));
}

/** Run only independent tasks together and wait for every started task's cleanup before returning. */
export async function executeGraphTasks<T>(
  tasks: GraphExecutionTask[], maxParallel: number, signal: AbortSignal,
  execute: (task: GraphExecutionTask, index: number) => Promise<T>,
  options: GraphTaskExecutionOptions = {},
): Promise<GraphTaskOutcome<T>[]> {
  signal.throwIfAborted();
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("Task concurrency must be between 1 and 8");
  if (!tasks.length || tasks.length > 8) throw new Error("Task execution requires between 1 and 8 tasks");
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Task ids must be unique");
  tasks.forEach(normalizedWritePaths);
  const pending = tasks.map((_, index) => index);
  const active = new Map<number, Promise<void>>();
  const results: GraphTaskOutcome<T>[] = new Array(tasks.length);
  const compatible = (index: number, running: number): boolean => {
    const task = tasks[index]!;
    const other = tasks[running]!;
    return graphTasksCompatible(task, other, options.allowParallelWrites);
  };
  while (pending.length || active.size) {
    if (!signal.aborted) {
      for (let cursor = 0; cursor < pending.length && active.size < maxParallel;) {
        const index = pending[cursor]!;
        if (![...active.keys()].every(running => compatible(index, running))) { cursor += 1; continue; }
        pending.splice(cursor, 1);
        // Enter the active set before the callback starts, even when it settles synchronously.
        const operation = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return execute(tasks[index]!, index);
        }).then(
          value => { results[index] = { taskId: tasks[index]!.id, status: "fulfilled", value }; },
          error => { results[index] = { taskId: tasks[index]!.id, status: "rejected", error }; },
        ).finally(() => { active.delete(index); });
        active.set(index, operation);
      }
    }
    if (active.size) await Promise.race(active.values());
    else break;
  }
  // Aborted calls must never report unstarted tasks as success or replay them automatically.
  signal.throwIfAborted();
  return results;
}

async function git(workspacePath: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("git", args, { cwd: workspacePath, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    child.once("error", error => { cleanup(); rejectCommand(error); });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) rejectCommand(signal.reason);
      else if (code === 0) resolveCommand(stdout);
      else rejectCommand(new Error(`git ${args[0]} failed: ${stderr}`));
    });
  });
}

/** Includes current tracked/untracked contents without changing the child's or parent's real index. */
export async function captureGraphTaskBaseline(workspacePath: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const workspace = await realpath(workspacePath);
  const scratch = await mkdtemp(join(tmpdir(), "harness-task-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(workspace, ["read-tree", "HEAD"], signal, env);
    await git(workspace, ["add", "-A", "--", "."], signal, env);
    return (await git(workspace, ["write-tree"], signal, env)).trim();
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** A child's patch excludes inherited parent edits and includes newly created files. */
export async function graphTaskPatch(workspacePath: string, baseline: string, signal: AbortSignal): Promise<string> {
  return (await graphTaskChanges(workspacePath, baseline, signal)).patch;
}

export async function graphTaskChanges(workspacePath: string, baseline: string, signal: AbortSignal): Promise<{ patch: string; paths: string[] }> {
  if (!/^[a-f0-9]{40,64}$/.test(baseline)) throw new Error("Invalid task baseline tree");
  const current = await captureGraphTaskBaseline(workspacePath, signal);
  const patch = await git(workspacePath, ["diff", "--binary", baseline, current, "--", "."], signal);
  const paths = (await git(workspacePath, ["diff", "--name-only", "-z", baseline, current, "--", "."], signal)).split("\0").filter(Boolean);
  return { patch, paths };
}

export function graphTaskScopeViolations(task: GraphExecutionTask, changedPaths: string[]): string[] {
  const scope = normalizedWritePaths(task);
  if (!scope) return [];
  return changedPaths.filter(path => {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    return !scope.some(owned => owned === "." || normalized === owned || normalized.startsWith(`${owned}/`));
  });
}
