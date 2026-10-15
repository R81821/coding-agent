import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultCrypto } from "@harness/persistence";
import { WithdrawalSnapshotStore } from "../packages/core/src/withdrawal-snapshot.js";
import { RunReviewService, type ReviewRun } from "../packages/core/src/run-review.js";

const roots: string[] = [];
const vaults: VaultCrypto[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const crypto of vaults.splice(0)) crypto.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: {
    ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  } });
}
async function fixture(repository = false) {
  const root = await mkdtemp(join(tmpdir(), "message-withdrawal-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "original.txt"), "initial dirty bytes\r\n");
  if (repository) {
    git(workspace, "init", "-q");
    git(workspace, "config", "core.autocrlf", "false");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");
  }
  const crypto = await VaultCrypto.open(join(root, "key.json"), "test-password");
  vaults.push(crypto);
  const backup = join(root, "backups");
  const store = new WithdrawalSnapshotStore(backup, crypto);
  const run = { id: "r1", sessionId: "s1", workspacePath: workspace };
  return { root, workspace, crypto, backup, store, run };
}
async function firstPause(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.begin(f.run);
  await writeFile(join(f.workspace, "original.txt"), "original round work");
  await writeFile(join(f.workspace, "keep.txt"), "keep earlier file");
  await f.store.finish(f.run.id, true);
}

// These fixtures execute many real Git/snapshot processes; a five-second deadline flakes
// under the full Windows suite and lets teardown race an otherwise healthy filesystem job.
describe("message withdrawal filesystem boundaries", { timeout: 20000 }, () => {
  it("restores one human segment and keeps prior work plus the original whole-round baseline", async () => {
    const f = await fixture();
    await firstPause(f);
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "message work");
    await rm(join(f.workspace, "keep.txt"));
    await writeFile(join(f.workspace, "new.txt"), "new message file");
    await f.store.finish(f.run.id, true);
    expect(await f.store.rollbackMessage(f.run.id, "m1", () => "saved")).toBe("saved");
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("original round work");
    expect(await readFile(join(f.workspace, "keep.txt"), "utf8")).toBe("keep earlier file");
    expect(await readdir(f.workspace)).not.toContain("new.txt");
    await f.store.rollback(f.run.id, () => undefined);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("initial dirty bytes\r\n");
    expect(await readdir(f.workspace)).not.toContain("keep.txt");
  });

  it("can withdraw consecutive segments after restart without losing chunks during cleanup", async () => {
    const f = await fixture();
    await firstPause(f);
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "first message");
    await f.store.finish(f.run.id, true);
    await f.store.beginMessage(f.run.id, "m2");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "second message");
    await f.store.finish(f.run.id, true);
    const restored = new WithdrawalSnapshotStore(f.backup, f.crypto);
    // Discarding an unrelated run runs chunk GC, which must trace message boundaries too.
    await restored.discard(["unrelated"]);
    await restored.rollbackMessage(f.run.id, "m2", () => undefined);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("first message");
    await restored.rollbackMessage(f.run.id, "m1", () => undefined);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("original round work");
    await expect(restored.rollbackMessage(f.run.id, "m2", () => undefined)).rejects.toThrow("这条消息没有");
  });

  it("removes this and later boundaries when restoring an earlier segment", async () => {
    const f = await fixture();
    await firstPause(f);
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "first message");
    await f.store.finish(f.run.id, true);
    await f.store.beginMessage(f.run.id, "m2");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "second message");
    await f.store.finish(f.run.id, true);
    await f.store.rollbackMessage(f.run.id, "m1", () => undefined);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("original round work");
    await expect(f.store.rollbackMessage(f.run.id, "m2", () => undefined)).rejects.toThrow("这条消息没有");
    await f.store.beginMessage(f.run.id, "m3");
  });

  it("compensates a failed message commit and retains the boundary for retry", async () => {
    const f = await fixture();
    await firstPause(f);
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "latest message work");
    await writeFile(join(f.workspace, "created.txt"), "latest new file");
    await f.store.finish(f.run.id, true);
    await expect(f.store.rollbackMessage(f.run.id, "m1", () => { throw new Error("database failed"); })).rejects.toThrow("database failed");
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("latest message work");
    expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe("latest new file");
    const retry = new WithdrawalSnapshotStore(f.backup, f.crypto);
    await retry.rollbackMessage(f.run.id, "m1", () => undefined);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("original round work");
  });

  it("refuses paused manual edits before creating a boundary and before restoring one", async () => {
    const f = await fixture();
    await firstPause(f);
    await writeFile(join(f.workspace, "original.txt"), "manual during pause");
    await expect(f.store.beginMessage(f.run.id, "m1")).rejects.toThrow("冲突");
    await expect(f.store.rollbackMessage(f.run.id, "m1", () => undefined)).rejects.toThrow("这条消息没有");
    await writeFile(join(f.workspace, "original.txt"), "original round work");
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "latest message work");
    await f.store.finish(f.run.id, true);
    await writeFile(join(f.workspace, "manual.txt"), "leave this alone");
    const commit = vi.fn();
    await expect(f.store.rollbackMessage(f.run.id, "m1", commit)).rejects.toThrow("冲突");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(f.workspace, "manual.txt"), "utf8")).toBe("leave this alone");
  });

  it("requires a stable paused boundary, rejects duplicates, and can cancel an unsubmitted boundary", async () => {
    const f = await fixture();
    await f.store.begin(f.run);
    await expect(f.store.beginMessage(f.run.id, "m1")).rejects.toThrow("暂停文件快照");
    await f.store.finish(f.run.id, true);
    await f.store.beginMessage(f.run.id, "m1");
    await expect(f.store.beginMessage(f.run.id, "m1")).rejects.toThrow("已存在");
    await f.store.cancelMessage(f.run.id, "m1");
    await f.store.cancelMessage(f.run.id, "missing");
    await expect(f.store.rollbackMessage(f.run.id, "m1", () => undefined)).rejects.toThrow("这条消息没有");
    await f.store.beginMessage(f.run.id, "m1");
  });

  it("restores the message's staged index and binary content while retaining the earlier segment", async () => {
    const f = await fixture(true);
    await firstPause(f);
    git(f.workspace, "add", "original.txt");
    // Stage before freezing the pause, since post-pause index edits intentionally conflict.
    await f.store.begin(f.run, true);
    await f.store.finish(f.run.id, true);
    const index = await readFile(join(f.workspace, ".git", "index"));
    await f.store.beginMessage(f.run.id, "m1");
    await f.store.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), Buffer.from([0, 1, 2, 3]));
    git(f.workspace, "add", "original.txt");
    await f.store.finish(f.run.id, true);
    await f.store.rollbackMessage(f.run.id, "m1", () => undefined);
    expect(await readFile(join(f.workspace, ".git", "index"))).toEqual(index);
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("original round work");
  }, 30_000);
});

describe("message withdrawal review integration", { timeout: 20000 }, () => {
  it("preserves previous child reviews and invalidates only children created by the withdrawn message", async () => {
    const f = await fixture(true);
    const earlierChild = { ...f.run, id: "earlier-child", parentRunId: f.run.id };
    const laterChild = { ...f.run, id: "later-child", parentRunId: f.run.id };
    const runs = new Map([f.run, earlierChild, laterChild].map(run => [run.id, run]));
    const review = new RunReviewService(join(f.root, "reviews"), f.crypto, { getRun: id => runs.get(id) });
    await review.begin(f.run);
    await review.begin(earlierChild);
    await writeFile(join(f.workspace, "earlier-child.txt"), "keep this child work\n");
    await review.finish(earlierChild.id, false);
    await review.finish(f.run.id, true);
    await review.beginMessageWithdrawal(f.run.id, "m1");
    await review.begin(f.run, true);
    await review.begin(laterChild);
    await writeFile(join(f.workspace, "later-child.txt"), "withdraw this child work\n");
    await review.finish(laterChild.id, false);
    await review.finish(f.run.id, true);
    await review.withdrawMessage(f.run.id, "m1", [f.run, laterChild], () => undefined);
    expect(await readFile(join(f.workspace, "earlier-child.txt"), "utf8")).toBe("keep this child work\n");
    expect(await readdir(f.workspace)).not.toContain("later-child.txt");
    expect(await review.get(earlierChild.id)).toMatchObject({ status: "ready", files: [expect.objectContaining({ path: "earlier-child.txt" })] });
    expect(await review.get(laterChild.id)).toMatchObject({ status: "unavailable", files: [] });
  }, 30_000);

  it("retains the original review baseline through message withdrawal and a later resume", async () => {
    const f = await fixture(true);
    const review = new RunReviewService(join(f.root, "reviews"), f.crypto);
    await review.begin(f.run);
    await writeFile(join(f.workspace, "original.txt"), "earlier work\n");
    await review.finish(f.run.id, true);
    await review.beginMessageWithdrawal(f.run.id, "m1");
    await review.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "withdrawn work\n");
    await writeFile(join(f.workspace, "withdrawn.txt"), "withdrawn file");
    await review.finish(f.run.id, true);
    await review.withdrawMessage(f.run.id, "m1", [f.run], () => undefined);
    expect(await review.get(f.run.id)).toMatchObject({ status: "capturing", files: [] });
    await review.begin(f.run, true);
    await writeFile(join(f.workspace, "later.txt"), "later work\n");
    await review.finish(f.run.id, false);
    const result = await review.get(f.run.id);
    expect(result.status).toBe("ready");
    expect(result.files.map(file => file.path)).toEqual(["later.txt", "original.txt"]);
    expect(result.files.find(file => file.path === "original.txt")?.diff).toContain("+earlier work");
    expect(result.files.find(file => file.path === "original.txt")?.diff).toContain("-initial dirty bytes");
  }, 30_000);

  it("checks active workspaces and outstanding child worktrees before restoring a message", async () => {
    const f = await fixture();
    let active: ReviewRun[] = [];
    const review = new RunReviewService(join(f.root, "reviews"), f.crypto, { activeRuns: () => active });
    await review.begin(f.run);
    await review.finish(f.run.id, true);
    active = [{ id: "other", sessionId: "other", workspacePath: f.workspace }];
    await expect(review.beginMessageWithdrawal(f.run.id, "m1")).rejects.toThrow("其他运行中的任务");
    active = [];
    await review.beginMessageWithdrawal(f.run.id, "m1");
    await review.begin(f.run, true);
    await writeFile(join(f.workspace, "original.txt"), "new work");
    await review.finish(f.run.id, true);
    const childWorkspace = join(f.root, "child");
    await mkdir(childWorkspace);
    const child = { id: "child", sessionId: f.run.sessionId, workspacePath: childWorkspace, parentRunId: f.run.id };
    const commit = vi.fn();
    await expect(review.withdrawMessage(f.run.id, "m1", [f.run, child], commit)).rejects.toThrow("独立工作区");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(f.workspace, "original.txt"), "utf8")).toBe("new work");
    await review.withdrawMessage(f.run.id, "m1", [f.run], commit);
    expect(commit).toHaveBeenCalledOnce();
  });
});
