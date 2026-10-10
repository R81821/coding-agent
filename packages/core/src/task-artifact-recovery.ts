import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { HarnessDatabase } from "@harness/persistence";
import type { RunStatus, TaskExecution } from "@harness/protocol";
import { graphTaskChanges, graphTaskScopeViolations } from "./graph-task-execution.js";

const executeFile = promisify(execFile);
const parkedStatuses = new Set<RunStatus>(["paused", "review", "completed", "failed", "cancelled"]);

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function gitPath(workspace: string, flag: "--git-common-dir" | "--git-dir" | "--show-toplevel", signal: AbortSignal): Promise<string> {
  const { stdout } = await executeFile("git", ["rev-parse", "--path-format=absolute", flag], {
    cwd: workspace, windowsHide: true, signal, maxBuffer: 64_000,
  });
  return realpath(resolve(workspace, stdout.trim()));
}

/** Recover actual child edits for inspection; this never merges, resumes or verifies a node. */
export async function recoverTaskArtifacts(database: HarnessDatabase, managedRoot: string): Promise<void> {
  let offset = 0;
  for (;;) {
    let page;
    try { page = database.listRunHistory(200, offset); }
    catch { return; } // A storage failure must not prevent the rest of startup from running.
    for (const parent of page.items) {
      if (parent.status !== "paused") continue;
      try {
        const checkpoint = database.getLatestCheckpoint(parent.id);
        if (checkpoint?.runId !== parent.id) continue;
        const candidates = checkpoint.workflow?.sequential?.taskExecutions.filter(record =>
          record.mode === "write" && record.workspacePath && record.baselineTree && record.patch === undefined,
        ) ?? [];
        for (const record of candidates) await recoverRecord(database, parent.id, parent.workspacePath, record, managedRoot);
      } catch { /* An unreadable parent does not block recovery of other parents. */ }
    }
    if (!page.hasMore) return;
    offset += page.items.length;
  }
}

async function recoverRecord(database: HarnessDatabase, parentId: string, parentWorkspace: string, record: TaskExecution, managedRoot: string): Promise<void> {
  let patch: string | undefined;
  let summary: string;
  let validatedChildWorkspace: string | undefined;
  const originalRecord = JSON.stringify(record);
  try {
    const child = record.childRunId ? database.getRun(record.childRunId) : undefined;
    if (!child || child.spec.parentRunId !== parentId || child.spec.parentStepId !== record.stepId) {
      throw new Error("The child does not belong to this parent and graph node.");
    }
    if (!parkedStatuses.has(child.status)) throw new Error("The child is still active or queued; its workspace cannot be recovered.");
    validatedChildWorkspace = child.spec.workspacePath;
    if (!isAbsolute(record.workspacePath!) || !isAbsolute(child.spec.workspacePath)) throw new Error("The child workspace must be an absolute path.");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.baselineTree!)) throw new Error("The task baseline tree is invalid.");
    const [managed, workspace, childWorkspace, parent] = await Promise.all([
      realpath(managedRoot), realpath(record.workspacePath!), realpath(child.spec.workspacePath), realpath(parentWorkspace),
    ]);
    if (!within(managed, workspace)) throw new Error("The task workspace escapes the managed worktree root.");
    if (!samePath(workspace, childWorkspace)) throw new Error("The recorded workspace differs from the child's actual workspace.");
    if (samePath(workspace, parent)) throw new Error("The task workspace is the parent workspace, not an isolated worktree.");
    const signal = AbortSignal.timeout(30_000);
    const [childCommon, parentCommon, childGit, topLevel] = await Promise.all([
      gitPath(workspace, "--git-common-dir", signal), gitPath(parent, "--git-common-dir", signal),
      gitPath(workspace, "--git-dir", signal), gitPath(workspace, "--show-toplevel", signal),
    ]);
    if (!samePath(childCommon, parentCommon)) throw new Error("The worktree belongs to a different Git repository.");
    if (samePath(childCommon, childGit) || !samePath(topLevel, workspace)) throw new Error("The recorded path is not the root of a linked Git worktree.");
    const changes = await graphTaskChanges(workspace, record.baselineTree!, signal);
    const violations = graphTaskScopeViolations({ id: record.taskId, prompt: "", mode: record.mode, ...(record.writePaths ? { writePaths: record.writePaths } : {}) }, changes.paths);
    if (violations.length) throw new Error(`The child wrote outside its declared scope: ${violations.join(", ")}`);
    patch = changes.patch;
    summary = `Recovered ${changes.paths.length} changed file(s) from the parked child worktree. The patch is available for inspection; the graph node still requires integration and verification.`;
  } catch (error) {
    summary = `Task artifact recovery unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    const parent = database.getRun(parentId);
    if (parent?.status !== "paused" || parent.spec.workspacePath !== parentWorkspace) return;
    const checkpoint = database.getLatestCheckpoint(parentId);
    const current = checkpoint?.workflow?.sequential?.taskExecutions.find(task => task.taskId === record.taskId && task.stepId === record.stepId);
    // Do not overwrite a newer checkpoint or a result published while Git was being inspected.
    if (!checkpoint || checkpoint.runId !== parentId || !current || JSON.stringify(current) !== originalRecord) return;
    if (patch !== undefined) {
      const child = current.childRunId ? database.getRun(current.childRunId) : undefined;
      if (!child || !parkedStatuses.has(child.status) || child.spec.parentRunId !== parentId || child.spec.parentStepId !== current.stepId
        || child.spec.workspacePath !== validatedChildWorkspace) return;
      current.patch = patch;
    }
    current.summary = summary.slice(0, 6000);
    database.saveCheckpoint(checkpoint);
  } catch { /* Keep startup usable even if one checkpoint cannot be updated. */ }
}
