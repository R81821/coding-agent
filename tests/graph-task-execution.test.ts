import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "@harness/extensions";
import { captureGraphTaskBaseline, executeGraphTasks, graphTaskChanges, graphTaskScopeViolations, type GraphExecutionTask } from "../packages/core/src/graph-task-execution.js";

const run = promisify(execFile);
const task = (id: string, mode: "read" | "write" = "read", writePaths?: string[]): GraphExecutionTask => ({ id, prompt: id, mode, ...(writePaths ? { writePaths } : {}) });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("graph task execution", () => {
  it("actually runs isolated independent writes concurrently and respects the cap", async () => {
    const releases = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const completion = executeGraphTasks([task("a", "write", ["src/a.ts"]), task("b", "write", ["src/b.ts"]), task("c", "write", ["src/c.ts"])], 2, new AbortController().signal, async (item, index) => {
      started.push(item.id);
      active += 1;
      maximum = Math.max(maximum, active);
      await releases[index]!.promise;
      active -= 1;
      return item.id;
    }, { allowParallelWrites: true });
    await turn();
    expect(started).toEqual(["a", "b"]);
    releases[1]!.release();
    await turn();
    expect(started).toEqual(["a", "b", "c"]);
    releases[2]!.release();
    releases[0]!.release();
    expect(await completion).toEqual(["a", "b", "c"].map(id => ({ taskId: id, status: "fulfilled", value: id })));
    expect(maximum).toBe(2);
  });

  it("serializes overlapping directories and case-insensitive file owners", async () => {
    const first = deferred();
    const third = deferred();
    const started: string[] = [];
    const completion = executeGraphTasks([task("directory", "write", ["SRC"]), task("file", "write", ["src/a.ts"]), task("outside", "write", ["tests/a.ts"])], 3, new AbortController().signal, async item => {
      started.push(item.id);
      if (item.id === "directory") await first.promise;
      if (item.id === "outside") await third.promise;
      return item.id;
    }, { allowParallelWrites: true });
    await turn();
    expect(started).toEqual(["directory", "outside"]);
    first.release();
    await turn();
    expect(started).toEqual(["directory", "outside", "file"]);
    third.release();
    await completion;
  });

  it("treats unknown and glob write scopes conservatively", async () => {
    const first = deferred();
    const started: string[] = [];
    const completion = executeGraphTasks([task("unknown", "write"), task("declared", "write", ["src/a.ts"]), task("glob", "write", ["tests/*.ts"]), task("read")], 4, new AbortController().signal, async item => {
      started.push(item.id);
      if (item.id === "unknown") await first.promise;
      return item.id;
    }, { allowParallelWrites: true });
    await turn();
    expect(started).toEqual(["unknown", "read"]);
    first.release();
    await completion;
    expect(started).toEqual(["unknown", "read", "declared", "glob"]);
  });

  it("keeps shared-workspace writes exclusive even against readers", async () => {
    const first = deferred();
    const started: string[] = [];
    const completion = executeGraphTasks([task("write", "write", ["a"]), task("read-a"), task("read-b"), task("write-b", "write", ["b"])], 4, new AbortController().signal, async item => {
      started.push(item.id);
      if (item.id === "write") await first.promise;
      await turn();
      return item.id;
    });
    await turn();
    expect(started).toEqual(["write"]);
    first.release();
    await completion;
    expect(started).toEqual(["write", "read-a", "read-b", "write-b"]);
  });

  it("stops queued tasks on abort and awaits active child cleanup without replay", async () => {
    const controller = new AbortController();
    const cleanup = deferred();
    const started: string[] = [];
    let settled = false;
    const completion = executeGraphTasks([task("active", "write"), task("queued", "write")], 2, controller.signal, async item => {
      started.push(item.id);
      await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup.promise;
      controller.signal.throwIfAborted();
      return item.id;
    }, { allowParallelWrites: true });
    const observed = completion.catch(() => { settled = true; });
    await turn();
    controller.abort(new Error("paused by user"));
    await turn();
    expect(settled).toBe(false);
    expect(started).toEqual(["active"]);
    cleanup.release();
    await expect(completion).rejects.toThrow("paused by user");
    await observed;
    expect(started).toEqual(["active"]);
  });

  it("reports failures only after sibling work has settled", async () => {
    const cleanup = deferred();
    let settled = false;
    const completion = executeGraphTasks([task("bad"), task("sibling")], 2, new AbortController().signal, async item => {
      if (item.id === "bad") throw new Error("failed child");
      await cleanup.promise;
      return "finished cleanup";
    });
    const observed = completion.then(() => { settled = true; });
    await turn();
    expect(settled).toBe(false);
    cleanup.release();
    const results = await completion;
    await observed;
    expect(results[0]).toMatchObject({ taskId: "bad", status: "rejected", error: new Error("failed child") });
    expect(results[1]).toEqual({ taskId: "sibling", status: "fulfilled", value: "finished cleanup" });
  });

  it("rejects invalid graphs before starting any callback and checks actual output scope", async () => {
    let started = 0;
    const execute = async () => { started += 1; return "unexpected"; };
    await expect(executeGraphTasks([task("bad", "write", ["../outside"])], 1, new AbortController().signal, execute)).rejects.toThrow("workspace-relative");
    await expect(executeGraphTasks([task("same"), task("same")], 1, new AbortController().signal, execute)).rejects.toThrow("unique");
    await expect(executeGraphTasks([task("bad")], 0, new AbortController().signal, execute)).rejects.toThrow("between 1 and 8");
    expect(started).toBe(0);
    expect(graphTaskScopeViolations(task("owned", "write", ["src/a.ts", "tests"]), ["src/a.ts", "tests/new.ts", "src/b.ts"])).toEqual(["src/b.ts"]);
  });

  it("inherits dirty Git source and returns an applicable incremental patch with new files", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-graph-git-"));
    const managed = await mkdtemp(join(tmpdir(), "harness-graph-leases-"));
    let lease: Awaited<ReturnType<WorktreeManager["create"]>> | undefined;
    const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
    try {
      await git("init");
      await git("config", "user.email", "test@example.invalid");
      await git("config", "user.name", "Graph fixture");
      await git("config", "core.autocrlf", "false");
      await writeFile(join(root, "source.txt"), "head\n");
      await git("add", "source.txt");
      await git("commit", "-m", "baseline");
      await writeFile(join(root, "source.txt"), "parent staged\n");
      await git("add", "source.txt");
      await writeFile(join(root, "source.txt"), "parent dirty\n");
      await writeFile(join(root, "parent-untracked.txt"), "inherited\n");
      const parentIndex = (await git("diff", "--cached", "--binary")).stdout;
      lease = await new WorktreeManager(managed).create(root, "parent", "task", new AbortController().signal);
      expect(await readFile(join(lease.path, "source.txt"), "utf8")).toBe("parent dirty\n");
      expect(await readFile(join(lease.path, "parent-untracked.txt"), "utf8")).toBe("inherited\n");
      const childIndex = (await run("git", ["diff", "--cached", "--binary"], { cwd: lease.path, windowsHide: true })).stdout;
      const baseline = await captureGraphTaskBaseline(lease.path, new AbortController().signal);
      expect((await run("git", ["diff", "--cached", "--binary"], { cwd: lease.path, windowsHide: true })).stdout).toBe(childIndex);
      await writeFile(join(lease.path, "source.txt"), "parent dirty\nchild edit\n");
      await writeFile(join(lease.path, "new.txt"), "new child file\n");
      await writeFile(join(lease.path, "binary.bin"), Buffer.from([0, 255, 1, 254]));
      const changes = await graphTaskChanges(lease.path, baseline, new AbortController().signal);
      expect(changes.paths).toEqual(["binary.bin", "new.txt", "source.txt"]);
      expect(changes.patch).toContain("+child edit");
      expect(changes.patch).not.toContain("+parent dirty");
      expect(changes.patch).not.toContain("parent-untracked.txt");
      expect(changes.patch).toContain("GIT binary patch");
      const patchFile = join(managed, "result.patch");
      await writeFile(patchFile, changes.patch);
      await git("apply", "--check", patchFile);
      await git("apply", patchFile);
      expect(await readFile(join(root, "source.txt"), "utf8")).toBe("parent dirty\nchild edit\n");
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new child file\n");
      expect(await readFile(join(root, "binary.bin"))).toEqual(Buffer.from([0, 255, 1, 254]));
      expect((await git("diff", "--cached", "--binary")).stdout).toBe(parentIndex);
    } finally {
      await lease?.cleanup();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(managed, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);

  it("permits the same task to be retried in distinct worktrees without leaving branch leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-graph-retry-"));
    const managed = await mkdtemp(join(tmpdir(), "harness-graph-retry-leases-"));
    const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
    const leases: Array<Awaited<ReturnType<WorktreeManager["create"]>>> = [];
    try {
      await git("init");
      await git("config", "user.email", "test@example.invalid");
      await git("config", "user.name", "Graph fixture");
      await git("config", "core.autocrlf", "false");
      await writeFile(join(root, "source.txt"), "head\n");
      await git("add", "source.txt");
      await git("commit", "-m", "baseline");
      const manager = new WorktreeManager(managed);
      leases.push(...await Promise.all([
        manager.create(root, "parent", "same-task", new AbortController().signal),
        manager.create(root, "parent", "same-task", new AbortController().signal),
      ]));
      expect(leases[0]!.path).not.toBe(leases[1]!.path);
      expect(leases[0]!.branch).not.toBe(leases[1]!.branch);
      await writeFile(join(leases[0]!.path, "source.txt"), "first child\n");
      expect(await readFile(join(leases[1]!.path, "source.txt"), "utf8")).toBe("head\n");
      for (const lease of leases.splice(0)) await lease.cleanup();
      expect(await readdir(managed)).toEqual([]);
      expect((await git("branch", "--list", "harness/*")).stdout).toBe("");
      expect((await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      for (const lease of leases) await lease.cleanup();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(managed, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);

  it("removes allocated Git leases when creating a worktree fails or is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-graph-cancel-"));
    const managed = await mkdtemp(join(tmpdir(), "harness-graph-cancel-leases-"));
    const git = (...args: string[]) => run("git", args, { cwd: root, windowsHide: true });
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      const manager = new WorktreeManager(managed);
      await git("init");
      // No HEAD exists; git worktree add fails after the lease directory is allocated.
      await expect(manager.create(root, "parent", "missing-head", new AbortController().signal)).rejects.toThrow("git worktree");
      expect(await readdir(managed)).toEqual([]);
      await git("config", "user.email", "test@example.invalid");
      await git("config", "user.name", "Graph fixture");
      await writeFile(join(root, "source.txt"), "head\n");
      await git("add", "source.txt");
      await git("commit", "-m", "baseline");
      const controller = new AbortController();
      watcher = watch(managed, (_event, filename) => {
        if (filename?.toString().startsWith("lease-")) controller.abort(new Error("pause during lease creation"));
      });
      await expect(manager.create(root, "parent", "cancelled", controller.signal)).rejects.toThrow("pause during lease creation");
      watcher.close();
      watcher = undefined;
      expect(await readdir(managed)).toEqual([]);
      expect((await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
      expect((await git("branch", "--list", "harness/*")).stdout).toBe("");
    } finally {
      watcher?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(managed, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
