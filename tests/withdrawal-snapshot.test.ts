import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultCrypto } from "@harness/persistence";
import { WithdrawalSnapshotStore } from "../packages/core/src/withdrawal-snapshot.js";

const roots: string[] = [];
const vaults: VaultCrypto[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const vault of vaults.splice(0)) vault.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: {
    ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  } });
}
async function fixture(repository = false) {
  const root = await mkdtemp(join(tmpdir(), "withdrawal-snapshot-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "original.txt"), "dirty before\r\n");
  if (repository) {
    git(workspace, "init", "-q");
    git(workspace, "config", "core.autocrlf", "false");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");
  }
  const crypto = await VaultCrypto.open(join(root, "key.json"), "test-password");
  vaults.push(crypto);
  const storeRoot = join(root, "backups");
  const store = new WithdrawalSnapshotStore(storeRoot, crypto);
  const run = { id: "run-1", sessionId: "session-1", workspacePath: workspace };
  return { root, workspace, crypto, storeRoot, store, run };
}
async function chunks(root: string): Promise<string[]> {
  const output: string[] = [];
  try {
    for (const prefix of await readdir(join(root, "chunks")))
      for (const name of await readdir(join(root, "chunks", prefix))) output.push(join(root, "chunks", prefix, name));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return output;
}

// Real Git processes, encrypted snapshots and chunk collection share Windows disk resources.
describe("withdrawal filesystem snapshots", { timeout: 20000 }, () => {
  it("restores non-Git dirty bytes, binary files, ignored directories and deletions without retaining created files", async () => {
    const { workspace, store, run } = await fixture();
    const binary = Buffer.alloc(2 * 1024 * 1024 + 17, 0x7e); binary[8] = 0;
    await mkdir(join(workspace, ".cache"));
    await writeFile(join(workspace, ".cache", "binary.bin"), binary);
    await writeFile(join(workspace, "deleted.txt"), "restore me");
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "run wrote\n");
    await writeFile(join(workspace, ".cache", "binary.bin"), Buffer.from([0, 1, 2]));
    await rm(join(workspace, "deleted.txt"));
    await mkdir(join(workspace, "new-empty"));
    await mkdir(join(workspace, "new-dir"));
    await writeFile(join(workspace, "new-dir", "created.txt"), "new");
    await store.finish(run.id, true);
    const commit = vi.fn(() => "committed");
    expect(await store.rollback(run.id, commit)).toBe("committed");
    expect(commit).toHaveBeenCalledOnce();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
    expect(await readFile(join(workspace, ".cache", "binary.bin"))).toEqual(binary);
    expect(await readFile(join(workspace, "deleted.txt"), "utf8")).toBe("restore me");
    expect(await readdir(workspace)).not.toContain("new-dir");
    expect(await readdir(workspace)).not.toContain("new-empty");
  }, 30_000);

  it("restores the original staged index, unstaged bytes, Git ignored files and newly ignored files", async () => {
    const { workspace, store, run } = await fixture(true);
    await writeFile(join(workspace, ".gitignore"), "ignored/\n");
    await mkdir(join(workspace, "ignored"));
    await writeFile(join(workspace, "ignored", "before.bin"), Buffer.from([0, 20, 30]));
    await writeFile(join(workspace, "original.txt"), "staged before\n");
    git(workspace, "add", "original.txt");
    await writeFile(join(workspace, "original.txt"), "unstaged before\r\n");
    const index = await readFile(join(workspace, ".git", "index"));
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "run changed\n");
    git(workspace, "add", "original.txt");
    await writeFile(join(workspace, "ignored", "before.bin"), "run");
    await writeFile(join(workspace, "ignored", "new.bin"), "created ignored");
    await store.finish(run.id, true);
    await store.rollback(run.id, () => undefined);
    expect(await readFile(join(workspace, ".git", "index"))).toEqual(index);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("unstaged before\r\n");
    expect(await readFile(join(workspace, "ignored", "before.bin"))).toEqual(Buffer.from([0, 20, 30]));
    expect(await readdir(join(workspace, "ignored"))).toEqual(["before.bin"]);
  }, 30_000);

  it("checks the complete frozen end before any modification and rejects paused manual edits", async () => {
    const { workspace, store, run } = await fixture();
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "run wrote");
    await writeFile(join(workspace, "created.txt"), "created by run");
    await store.finish(run.id, true);
    await writeFile(join(workspace, "original.txt"), "manual edit");
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("冲突");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("manual edit");
    expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("created by run");
  });

  it("leaves unchanged package hardlinks usable but refuses restoration of changed hardlinks", async () => {
    const { root, workspace, store, run } = await fixture();
    const shared = join(root, "package-store.txt"); await writeFile(shared, "package");
    await mkdir(join(workspace, "node_modules")); await link(shared, join(workspace, "node_modules", "package.txt"));
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "run source edit"); await store.finish(run.id, true);
    await store.rollback(run.id, () => undefined);
    expect(await readFile(shared, "utf8")).toBe("package");
    await store.discard([run.id]);
    const next = { ...run, id: "hardlink-edit" };
    await store.begin(next); await writeFile(join(workspace, "node_modules", "package.txt"), "run package edit"); await store.finish(next.id, true);
    const commit = vi.fn();
    await expect(store.rollback(next.id, commit)).rejects.toThrow("硬链接");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(shared, "utf8")).toBe("run package edit");
  });

  it("restores root-directory permission changes and preserves them after failed database commit", async () => {
    const { workspace, store, run } = await fixture();
    const before = (await stat(workspace)).mode & 0o777;
    await store.begin(run); await chmod(workspace, 0o444); await store.finish(run.id, true);
    const after = (await stat(workspace)).mode & 0o777;
    await expect(store.rollback(run.id, () => { throw new Error("commit failed"); })).rejects.toThrow("commit failed");
    expect((await stat(workspace)).mode & 0o777).toBe(after);
    await store.rollback(run.id, () => undefined);
    expect((await stat(workspace)).mode & 0o777).toBe(before);
  });

  it("compensates every changed file when the database commit fails, allowing a retry", async () => {
    const { workspace, store, run } = await fixture();
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "run wrote");
    await writeFile(join(workspace, "created.txt"), "new");
    await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => { throw new Error("commit failed"); })).rejects.toThrow("commit failed");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("run wrote");
    expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("new");
    await store.rollback(run.id, () => undefined);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
  });

  it("compensates a mid-restore write failure without losing any run bytes", async () => {
    const { workspace, store, run, crypto } = await fixture();
    await writeFile(join(workspace, "a.txt"), "before a");
    await store.begin(run);
    await writeFile(join(workspace, "a.txt"), "after a");
    await writeFile(join(workspace, "original.txt"), "after original");
    await store.finish(run.id, true);
    const decrypt = crypto.decryptBuffer.bind(crypto);
    let count = 0;
    vi.spyOn(crypto, "decryptBuffer").mockImplementation((buffer, aad) => {
      count++;
      if (count === 6) throw new Error("temporary write failure");
      return decrypt(buffer, aad);
    });
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("temporary write failure");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("after a");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("after original");
  });

  it("never overwrites a manual edit that appears during failed commit compensation", async () => {
    const { workspace, store, run } = await fixture();
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "run wrote");
    await store.finish(run.id, true);
    const fs = await import("node:fs");
    await expect(store.rollback(run.id, () => {
      fs.writeFileSync(join(workspace, "original.txt"), "manual during rollback");
      throw new Error("commit failed");
    })).rejects.toThrow("补偿未完成");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("manual during rollback");
  });

  it.each(["file-to-directory", "directory-to-file"])("restores %s type changes and compensates them", async direction => {
    const { workspace, store, run } = await fixture();
    const path = join(workspace, "shape");
    if (direction === "file-to-directory") await writeFile(path, "before file");
    else { await mkdir(path); await writeFile(join(path, "child.txt"), "before child"); }
    await store.begin(run);
    await rm(path, { recursive: true, force: true });
    if (direction === "file-to-directory") { await mkdir(path); await writeFile(join(path, "child.txt"), "after child"); }
    else await writeFile(path, "after file");
    await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => { throw new Error("commit failed"); })).rejects.toThrow("commit failed");
    if (direction === "file-to-directory") expect(await readFile(join(path, "child.txt"), "utf8")).toBe("after child");
    else expect(await readFile(path, "utf8")).toBe("after file");
    await store.rollback(run.id, () => undefined);
    if (direction === "file-to-directory") expect(await readFile(path, "utf8")).toBe("before file");
    else expect(await readFile(join(path, "child.txt"), "utf8")).toBe("before child");
  });

  it("records directory junctions without traversing external targets and restores directory-to-link changes", async () => {
    const { root, workspace, store, run } = await fixture();
    const external = join(root, "external");
    await mkdir(external); await writeFile(join(external, "keep.txt"), "external unchanged");
    await symlink(external, join(workspace, "existing-link"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(workspace, "shape"));
    await writeFile(join(workspace, "shape", "before.txt"), "before");
    await store.begin(run);
    await rm(join(workspace, "shape"), { recursive: true });
    await symlink(external, join(workspace, "shape"), process.platform === "win32" ? "junction" : "dir");
    await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => { throw new Error("commit failed"); })).rejects.toThrow("commit failed");
    expect(await readlink(join(workspace, "shape"))).toBe(await readlink(join(workspace, "existing-link")));
    await store.rollback(run.id, () => undefined);
    expect(await readFile(join(workspace, "shape", "before.txt"), "utf8")).toBe("before");
    expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("external unchanged");
    expect(await readlink(join(workspace, "existing-link"))).toBe(external);
  });

  it("survives restart and resumes from the original baseline instead of the first pause", async () => {
    const { workspace, store, storeRoot, crypto, run } = await fixture();
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "first pause"); await store.finish(run.id, true);
    const reopened = new WithdrawalSnapshotStore(storeRoot, crypto);
    await reopened.begin(run, true);
    await writeFile(join(workspace, "original.txt"), "second pause"); await reopened.finish(run.id, true);
    const restarted = new WithdrawalSnapshotStore(storeRoot, crypto);
    await restarted.rollback(run.id, () => undefined);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
  });

  it("refuses legacy resumed rounds without creating a misleading late baseline", async () => {
    const { workspace, store, run } = await fixture();
    await store.begin(run, true); await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => undefined)).rejects.toThrow("发送前");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
  });

  it("persists non-Git contamination from intervening runs even after they finish or the app restarts", async () => {
    const { workspace, store, storeRoot, crypto, run } = await fixture();
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "first run"); await store.finish(run.id, true);
    const other = { ...run, id: "run-2", sessionId: "session-2" };
    await new WithdrawalSnapshotStore(storeRoot, crypto).begin(other);
    await writeFile(join(workspace, "original.txt"), "intervening run");
    await new WithdrawalSnapshotStore(storeRoot, crypto).finish(other.id, false);
    await expect(new WithdrawalSnapshotStore(storeRoot, crypto).rollback(run.id, () => undefined)).rejects.toThrow("其他对话");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("intervening run");
  });

  it("rejects changed Git HEAD including a branch switch at the same commit", async () => {
    const { workspace, store, run } = await fixture(true);
    git(workspace, "branch", "same-commit");
    await store.begin(run);
    git(workspace, "switch", "-q", "same-commit");
    await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => undefined)).rejects.toThrow("HEAD");
    expect(git(workspace, "symbolic-ref", "--short", "HEAD").trim()).toBe("same-commit");
  }, 30_000);

  it.each(["config", "exclude", "hook", "ref", "log", "alternates"])("refuses a round that changed Git %s metadata without committing or restoring files", async kind => {
    const { root, workspace, store, run } = await fixture(true);
    await store.begin(run);
    await writeFile(join(workspace, "original.txt"), "round changed source");
    const metadata = join(workspace, ".git");
    if (kind === "config") git(workspace, "config", "--local", "withdraw.audit", "round-created");
    else if (kind === "exclude") await writeFile(join(metadata, "info", "exclude"), "round-exclude\n");
    else if (kind === "hook") await writeFile(join(metadata, "hooks", "withdraw-audit"), "round-hook\n");
    else if (kind === "ref") git(workspace, "update-ref", "refs/tags/withdraw-audit", "HEAD");
    else if (kind === "log") await writeFile(join(metadata, "logs", "HEAD"), "round-log\n");
    else {
      const alternate = join(root, "alternate-objects"); await mkdir(alternate);
      await writeFile(join(metadata, "objects", "info", "alternates"), `${alternate.replaceAll("\\", "/")}\n`);
    }
    await store.finish(run.id, true);
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("元数据");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("round changed source");
  }, 30_000);

  it("refuses Git metadata edits made after the frozen pause before touching any file", async () => {
    const { workspace, store, run } = await fixture(true);
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "run wrote"); await store.finish(run.id, true);
    git(workspace, "config", "--local", "withdraw.audit", "manual edit after pause");
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("冲突");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("run wrote");
    expect(git(workspace, "config", "--local", "--get", "withdraw.audit").trim()).toBe("manual edit after pause");
  }, 30_000);

  it("checks linked worktrees' common metadata while allowing their own index and ordinary object writes", async () => {
    const { root, workspace, store, run } = await fixture(true);
    const linked = join(root, "linked"); git(workspace, "worktree", "add", "-q", "--detach", linked);
    const linkedRun = { ...run, workspacePath: linked };
    const indexPath = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
    const beforeIndex = await readFile(indexPath);
    await store.begin(linkedRun);
    await writeFile(join(linked, "original.txt"), "worktree run content");
    git(linked, "add", "original.txt");
    git(linked, "hash-object", "-w", "original.txt");
    await store.finish(linkedRun.id, true);
    await store.rollback(linkedRun.id, () => undefined);
    expect(await readFile(join(linked, "original.txt"), "utf8")).toBe("dirty before\r\n");
    expect(await readFile(indexPath)).toEqual(beforeIndex);
    await store.discard([linkedRun.id]);
    const next = { ...linkedRun, id: "common-config-change" };
    await store.begin(next); await writeFile(join(linked, "original.txt"), "next run content");
    git(linked, "config", "--local", "withdraw.audit", "shared configuration change");
    await store.finish(next.id, true);
    const commit = vi.fn();
    await expect(store.rollback(next.id, commit)).rejects.toThrow("元数据");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(linked, "original.txt"), "utf8")).toBe("next run content");
  }, 30_000);

  it("rejects a root replaced by the round before restoring any bytes", async () => {
    const { root, workspace, store, run } = await fixture();
    const fs = await import("node:fs");
    await store.begin(run);
    fs.renameSync(workspace, join(root, "original-root"));
    await mkdir(workspace); await writeFile(join(workspace, "original.txt"), "round replaced root");
    await store.finish(run.id, true);
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("根目录");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("round replaced root");
  });

  it.each(["restoring-record", "restored-bytes"])("never touches a replacement root appearing during %s", async point => {
    const { root, workspace, store, run, crypto } = await fixture();
    const fs = await import("node:fs");
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "run content"); await store.finish(run.id, true);
    const moved = join(root, "original-root");
    let replaced = false;
    const replaceRoot = () => {
      if (replaced) return;
      replaced = true;
      fs.renameSync(workspace, moved); fs.mkdirSync(workspace);
      fs.writeFileSync(join(workspace, "original.txt"), "new owner's file");
    };
    if (point === "restoring-record") {
      const encrypt = crypto.encryptJson.bind(crypto);
      vi.spyOn(crypto, "encryptJson").mockImplementation((value, aad) => {
        if (typeof value === "object" && value !== null && "status" in value && value.status === "restoring") replaceRoot();
        return encrypt(value, aad);
      });
    } else {
      const guarded = store as unknown as { assertRoot(path: string, state: unknown, checkMode?: boolean): Promise<unknown> };
      const assertRoot = guarded.assertRoot.bind(guarded);
      vi.spyOn(guarded, "assertRoot").mockImplementation(async (...args) => {
        // The write guard runs again after the temporary handle closes, before its publication.
        // Windows does not allow renaming a directory while one of its files is open.
        if (!replaced && fs.readdirSync(workspace).some(name => name.startsWith(".withdrawal-"))) replaceRoot();
        return assertRoot(...args);
      });
    }
    const commit = vi.fn();
    await expect(store.rollback(run.id, commit)).rejects.toThrow("根目录");
    expect(replaced).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual(["original.txt"]);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("new owner's file");
    if (point === "restoring-record") expect(await readFile(join(moved, "original.txt"), "utf8")).toBe("run content");
  });

  it("refuses legacy records missing a complete Git metadata fingerprint", async () => {
    const { workspace, store, storeRoot, run, crypto } = await fixture(true);
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "run content"); await store.finish(run.id, true);
    const recordPath = join(storeRoot, (await readdir(storeRoot)).find(name => name.endsWith(".snapshot"))!);
    const record = crypto.decryptJson<{ before: { git: { metadataFingerprint?: string; commonDirectory?: string } }; end: { git: { metadataFingerprint?: string; commonDirectory?: string } } }>(await readFile(recordPath, "utf8"), "withdrawal-snapshot-v1");
    delete record.before.git.metadataFingerprint; delete record.end.git.metadataFingerprint;
    delete record.before.git.commonDirectory; delete record.end.git.commonDirectory;
    await writeFile(recordPath, crypto.encryptJson(record, "withdrawal-snapshot-v1"));
    const commit = vi.fn();
    await expect(new WithdrawalSnapshotStore(storeRoot, crypto).rollback(run.id, commit)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("run content");
  }, 30_000);

  it("rejects missing or corrupted backup chunks before restoring or committing", async () => {
    const { workspace, store, storeRoot, crypto, run } = await fixture();
    await store.begin(run); await writeFile(join(workspace, "original.txt"), "after"); await store.finish(run.id, true);
    const blobs = await chunks(storeRoot);
    await writeFile(blobs[0]!, "corrupted ciphertext");
    const commit = vi.fn();
    await expect(new WithdrawalSnapshotStore(storeRoot, crypto).rollback(run.id, commit)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("after");
  });

  it("does not block normal execution when capture encounters nested Git or its own storage inside the workspace", async () => {
    const { workspace, store, run, crypto } = await fixture();
    await mkdir(join(workspace, "nested")); await mkdir(join(workspace, "nested", ".git"));
    await expect(store.begin(run)).resolves.toBeUndefined();
    await store.finish(run.id, true);
    await expect(store.rollback(run.id, () => undefined)).rejects.toThrow("嵌套");
    const inside = new WithdrawalSnapshotStore(join(workspace, "backups"), crypto);
    await inside.begin({ ...run, id: "inside" }); await inside.finish("inside", true);
    await expect(inside.rollback("inside", () => undefined)).rejects.toThrow("工作区外");
  });

  it("does not resurrect deleted-session snapshots and supports new runs after restoring that session", async () => {
    const { workspace, store, storeRoot, run } = await fixture();
    const beginning = store.begin(run);
    const deleting = store.deleteSession(run.sessionId);
    await Promise.all([beginning, deleting]);
    await expect(stat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    store.restoreSession(run.sessionId);
    await store.begin({ ...run, id: "new-run" }); await writeFile(join(workspace, "original.txt"), "new changed"); await store.finish("new-run", true);
    await store.rollback("new-run", () => undefined);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
    await store.begin(run, true);
    await expect(store.rollback(run.id, () => undefined)).rejects.toThrow();
  });

  it("deduplicates encrypted content and cleans completed/session-deleted records without deleting another paused backup", async () => {
    const { root, workspace, store, storeRoot, run } = await fixture();
    const otherWorkspace = join(root, "other-workspace"); await mkdir(otherWorkspace);
    await writeFile(join(otherWorkspace, "original.txt"), "dirty before\r\n");
    await store.begin(run);
    const other = { ...run, id: "other", sessionId: "other-session", workspacePath: otherWorkspace };
    await store.begin(other);
    expect(await chunks(storeRoot)).toHaveLength(1);
    const ciphertext = await readFile((await chunks(storeRoot))[0]!, "utf8");
    expect(ciphertext).not.toContain("dirty before");
    await store.finish(run.id, false);
    expect(await chunks(storeRoot)).toHaveLength(1);
    await writeFile(join(otherWorkspace, "original.txt"), "other changed"); await store.finish(other.id, true);
    await store.rollback(other.id, () => undefined);
    expect(await readFile(join(otherWorkspace, "original.txt"), "utf8")).toBe("dirty before\r\n");
    await store.deleteSession(other.sessionId);
    await expect(stat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await store.begin({ ...run, id: "next" }); await writeFile(join(workspace, "original.txt"), "next"); await store.finish("next", true);
    await store.rollback("next", () => undefined);
  });
});
