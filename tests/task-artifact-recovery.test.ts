import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, type WorktreeLease } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, SequentialPlanStepSchema, nowIso, type RunCheckpoint, type RunSpec, type RunStatus, type TaskExecution } from "@harness/protocol";
import { captureGraphTaskBaseline } from "../packages/core/src/graph-task-execution.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";
import { recoverTaskArtifacts } from "../packages/core/src/task-artifact-recovery.js";

const executeFile = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => executeFile("git", args, { cwd, windowsHide: true });

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init");
  await git(path, "config", "user.email", "test@example.invalid");
  await git(path, "config", "user.name", "Artifact recovery fixture");
  await git(path, "config", "core.autocrlf", "false");
  await writeFile(join(path, "source.txt"), "head\n");
  await git(path, "add", "source.txt");
  await git(path, "commit", "-m", "baseline");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-task-artifact-"));
  const workspace = join(root, "parent");
  const managed = join(root, "managed");
  await repository(workspace);
  await writeFile(join(workspace, "source.txt"), "parent staged\n");
  await git(workspace, "add", "source.txt");
  await writeFile(join(workspace, "source.txt"), "parent dirty\n");
  await writeFile(join(workspace, "parent-untracked.txt"), "inherited parent file\n");
  const vault = await VaultCrypto.open(join(root, "key.json"), "artifact-recovery-password");
  const databasePath = join(root, "state.sqlite");
  let database = await HarnessDatabase.open(databasePath, vault);
  cleanup.push(async () => {
    database.close(); vault.dispose();
    const path = relative(tmpdir(), await realpath(root));
    if (!path || path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) throw new Error("Unsafe artifact fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const lease = await new WorktreeManager(managed).create(workspace, "parent-run", "source-task", new AbortController().signal);
  cleanup.push(() => lease.cleanup());
  const baselineTree = await captureGraphTaskBaseline(lease.path, new AbortController().signal);
  const parent: RunSpec = {
    id: "parent-run", sessionId: "session-artifacts", taskMode: "change", request: "Improve source and run tests", workspacePath: workspace,
    profileId: DEFAULT_PROFILE.id, attachments: [], grants: [], createdAt: nowIso(), budget: { ...DEFAULT_PROFILE.budget },
  };
  const child: RunSpec = { ...parent, id: "child-run", parentRunId: parent.id, parentStepId: "source-node", workspacePath: lease.path };
  const task: TaskExecution = {
    taskId: "source-task", stepId: "source-node", childRunId: child.id, mode: "write", status: "interrupted", startedAt: nowIso(),
    workspacePath: lease.path, baselineTree, writePaths: ["source.txt", "new.txt", "binary.bin"], summary: "The process stopped during the child edit.",
  };
  const workflow = new SequentialWorkflow(parent.request, () => {});
  workflow.state.sequential!.steps = [{
    ...SequentialPlanStepSchema.parse({ id: task.stepId, text: "Improve source", verification: [{ command: "node --test test/source.test.mjs" }] }),
    status: "in_progress", check: { status: "pending", revision: -1, epoch: "artifact", runId: "", reason: "" },
  }];
  workflow.state.sequential!.taskExecutions = [task];
  const checkpoint: RunCheckpoint = {
    id: "checkpoint-artifacts", runId: parent.id, sequence: 12, reason: "tool_batch", status: "paused", transcript: [],
    usage: { inputTokens: 50, outputTokens: 10, estimatedUsd: 0, costKnown: true }, turns: 3, toolCalls: 5,
    pendingNonIdempotentToolCalls: [{ id: "run-tasks-call", name: "run_tasks", input: { stepIds: [task.stepId] } }],
    workflow: workflow.snapshot(), createdAt: nowIso(),
  };
  database.saveRun(parent, "paused"); database.saveRun(child, "paused"); database.saveCheckpoint(checkpoint);
  const saveTask = (overrides: Partial<TaskExecution>) => {
    const saved = database.getLatestCheckpoint(parent.id)!;
    Object.assign(saved.workflow!.sequential!.taskExecutions[0]!, overrides);
    database.saveCheckpoint(saved);
  };
  const savedTask = () => database.getLatestCheckpoint(parent.id)!.workflow!.sequential!.taskExecutions[0]!;
  return {
    root, workspace, managed, lease, parent, child, task, checkpoint, saveTask, savedTask,
    get database() { return database; },
    async reopen() { database.close(); database = await HarnessDatabase.open(databasePath, vault); },
    async edit() { await writeFile(join(lease.path, "source.txt"), "parent dirty\nchild improvement\n"); await writeFile(join(lease.path, "new.txt"), "new child file\n"); },
  };
}

async function keepLease(lease: WorktreeLease): Promise<WorktreeLease> {
  cleanup.push(() => lease.cleanup());
  return lease;
}

describe("parked graph task artifact recovery", { timeout: 30_000 }, () => {
  it("recovers a real incremental binary patch after reopening storage without merging or completing the node", async () => {
    const f = await fixture();
    const parentIndex = (await git(f.workspace, "diff", "--cached", "--binary")).stdout;
    const childIndex = (await git(f.lease.path, "diff", "--cached", "--binary")).stdout;
    await f.edit(); await writeFile(join(f.lease.path, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    await f.reopen();
    await recoverTaskArtifacts(f.database, f.managed);
    const saved = f.savedTask();
    expect(saved.status).toBe("interrupted"); expect(saved.patch).toContain("+child improvement");
    expect(saved.patch).toContain("new child file"); expect(saved.patch).toContain("GIT binary patch");
    expect(saved.patch).not.toContain("+parent dirty"); expect(saved.patch).not.toContain("parent-untracked.txt");
    expect(saved.summary).toContain("Recovered 3 changed file(s)");
    expect(f.database.getRun(f.parent.id)?.status).toBe("paused"); expect(f.database.getRun(f.child.id)?.status).toBe("paused");
    const checkpoint = f.database.getLatestCheckpoint(f.parent.id)!;
    expect(checkpoint.workflow?.sequential?.steps[0]).toMatchObject({ status: "in_progress", check: { status: "pending" } });
    expect(checkpoint.pendingNonIdempotentToolCalls).toEqual(f.checkpoint.pendingNonIdempotentToolCalls);
    expect(checkpoint.turns).toBe(3); expect(checkpoint.toolCalls).toBe(5);
    expect(await readFile(join(f.workspace, "source.txt"), "utf8")).toBe("parent dirty\n");
    expect((await git(f.workspace, "diff", "--cached", "--binary")).stdout).toBe(parentIndex);
    expect((await git(f.lease.path, "diff", "--cached", "--binary")).stdout).toBe(childIndex);
    const patchFile = join(f.root, "recovered.patch"); await writeFile(patchFile, saved.patch as string);
    await git(f.workspace, "apply", "--check", patchFile);
    expect(await realpath(f.lease.path)).toBe(await realpath(f.task.workspacePath!));
    expect(f.database.listEvents(f.parent.id)).toEqual([]); // Recovery starts no child or command workflow.
    const once = JSON.stringify(checkpoint); await recoverTaskArtifacts(f.database, f.managed);
    expect(JSON.stringify(f.database.getLatestCheckpoint(f.parent.id))).toBe(once);
  });

  it("preserves a previously saved artifact even when the parked workspace changes again", async () => {
    const f = await fixture(); f.saveTask({ patch: "already saved artifact", summary: "existing summary" }); await f.edit();
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask()).toMatchObject({ patch: "already saved artifact", summary: "existing summary" });
  });

  it.each(["parentRunId", "parentStepId"] as const)("refuses a child with a mismatching %s", async field => {
    const f = await fixture(); await f.edit(); f.database.saveRun({ ...f.child, [field]: "unrelated" }, "paused");
    await f.reopen(); await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("does not belong to this parent and graph node");
  });

  it("refuses an existing child whose actual workspace differs from the recorded task workspace", async () => {
    const f = await fixture(); await f.edit();
    const other = await keepLease(await new WorktreeManager(f.managed).create(f.workspace, f.parent.id, "other-task", new AbortController().signal));
    f.database.saveRun({ ...f.child, workspacePath: other.path }, "paused");
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("differs from the child's actual workspace");
  });

  it("rejects every active or queued child status before inspecting its edits", async () => {
    const f = await fixture(); await f.edit();
    for (const status of ["queued", "planning", "running", "waiting_approval", "verifying"] satisfies RunStatus[]) {
      f.database.updateRunStatus(f.child.id, status);
      await recoverTaskArtifacts(f.database, f.managed);
      expect(f.savedTask().patch, status).toBeUndefined(); expect(f.savedTask().summary).toContain("still active or queued");
      expect(f.database.getRun(f.child.id)?.status).toBe(status);
    }
  });

  it("refuses a worktree reached through a managed-root junction that actually escapes the root", async () => {
    const f = await fixture();
    const outside = await keepLease(await new WorktreeManager(join(f.root, "outside")).create(f.workspace, f.parent.id, "outside-task", new AbortController().signal));
    await writeFile(join(outside.path, "source.txt"), "outside child edit\n");
    const escape = join(f.managed, "escape"); await symlink(outside.path, escape, "junction");
    f.saveTask({ workspacePath: escape }); f.database.saveRun({ ...f.child, workspacePath: escape }, "paused");
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("escapes the managed worktree root");
  });

  it("refuses a managed worktree belonging to another Git repository", async () => {
    const f = await fixture(); const foreignRoot = join(f.root, "foreign"); await repository(foreignRoot);
    const foreign = await keepLease(await new WorktreeManager(f.managed).create(foreignRoot, f.parent.id, "foreign-task", new AbortController().signal));
    const baselineTree = await captureGraphTaskBaseline(foreign.path, new AbortController().signal);
    await writeFile(join(foreign.path, "source.txt"), "foreign child edit\n");
    f.saveTask({ workspacePath: foreign.path, baselineTree }); f.database.saveRun({ ...f.child, workspacePath: foreign.path }, "paused");
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("different Git repository");
  });

  it("retains an explicit failure rather than publishing a patch containing writes outside the owned scope", async () => {
    const f = await fixture(); await f.edit(); f.saveTask({ writePaths: ["source.txt"] });
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("outside its declared scope: new.txt");
    expect(f.savedTask().status).toBe("interrupted"); expect(await readFile(join(f.lease.path, "new.txt"), "utf8")).toBe("new child file\n");
  });

  it("keeps startup usable and reports unavailable artifacts when a managed worktree is missing", async () => {
    const f = await fixture(); const absent = join(f.managed, "missing-worktree");
    f.saveTask({ workspacePath: absent }); f.database.saveRun({ ...f.child, workspacePath: absent }, "paused");
    await expect(recoverTaskArtifacts(f.database, f.managed)).resolves.toBeUndefined();
    expect(f.savedTask().patch).toBeUndefined(); expect(f.savedTask().summary).toContain("Task artifact recovery unavailable");
  });

  it("skips parents that are not paused without rewriting their checkpoint", async () => {
    const f = await fixture(); await f.edit();
    const original = JSON.stringify(f.database.getLatestCheckpoint(f.parent.id));
    for (const status of ["running", "verifying", "completed", "failed", "review", "cancelled"] satisfies RunStatus[]) {
      f.database.updateRunStatus(f.parent.id, status);
      await recoverTaskArtifacts(f.database, f.managed);
      expect(JSON.stringify(f.database.getLatestCheckpoint(f.parent.id)), status).toBe(original);
    }
  });

  it("stores an empty artifact for a stopped child with no new edits without claiming verification", async () => {
    const f = await fixture(); f.database.updateRunStatus(f.child.id, "failed");
    await recoverTaskArtifacts(f.database, f.managed);
    expect(f.savedTask()).toMatchObject({ patch: "", status: "interrupted" }); expect(f.savedTask().summary).toContain("Recovered 0 changed file(s)");
    expect(f.database.getRun(f.child.id)?.status).toBe("failed");
    expect(f.database.getLatestCheckpoint(f.parent.id)?.workflow?.localCheck.status).toBe("pending");
  });
});
