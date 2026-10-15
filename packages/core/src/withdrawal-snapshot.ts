import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath,
  rename, rmdir, stat, symlink, unlink, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { VaultCrypto } from "@harness/persistence";

const execute = promisify(execFile);
const CHUNK_SIZE = 1024 * 1024;
const RECORD_AAD = "withdrawal-snapshot-v1";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

interface RunIdentity { id: string; sessionId: string; workspacePath: string }
interface DirectoryEntry { kind: "directory"; mode: number }
interface LinkEntry { kind: "link"; mode: number; target: string; linkType: "file" | "dir" | "junction" }
interface FileEntry { kind: "file"; mode: number; hash: string; size: number; links: number; chunks: string[] }
type Entry = DirectoryEntry | LinkEntry | FileEntry;
interface GitLocation { root: string; directory: string; commonDirectory: string; indexPath: string; head: string }
interface GitState extends GitLocation { metadataFingerprint: string; index: FileEntry | null }
interface Snapshot { entries: Record<string, Entry>; rootMode: number; rootIdentity: string; git?: GitState }
interface RestorationState { entries: Map<string, Entry>; rootMode: number; rootIdentity: string; index: FileEntry | null | undefined }
interface StoredSnapshotRecord {
  version: 1;
  runId: string;
  sessionId: string;
  workspacePath: string;
  captureRoot: string;
  status: "capturing" | "paused" | "unavailable" | "restoring" | "rolled_back";
  owner?: "capturing" | "paused";
  reason?: string;
  before?: Snapshot;
  end?: Snapshot;
  // Insertion order follows accepted human messages. Each boundary is captured while paused,
  // before that message is committed; the initial whole-round baseline remains independent.
  messageBoundaries?: Record<string, Snapshot>;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mode(info: { mode: number }): number { return info.mode & 0o777; }
function rootIdentity(info: { dev: number; ino: number }): string { return `${info.dev}:${info.ino}`; }
function identity(entry: Entry | undefined): string {
  if (!entry) return "missing";
  if (entry.kind === "directory") return `directory:${entry.mode}`;
  if (entry.kind === "link") return `link:${entry.mode}:${entry.linkType}:${entry.target}`;
  return `file:${entry.mode}:${entry.size}:${entry.links}:${entry.hash}`;
}
function gitIdentity(git: GitLocation | GitState | undefined, includeIndex: boolean): string {
  if (!git) return "no-git";
  return JSON.stringify([git.root, git.directory, git.commonDirectory, git.indexPath, git.head,
    ...(includeIndex ? ["metadataFingerprint" in git ? git.metadataFingerprint : undefined,
      identity("index" in git ? git.index ?? undefined : undefined)] : [])]);
}
function differences(left: Snapshot, right: Snapshot): string[] {
  const names = new Set([...Object.keys(left.entries), ...Object.keys(right.entries)]);
  return [...names].filter(path => identity(left.entries[path]) !== identity(right.entries[path])).sort();
}

/** Complete, encrypted filesystem backups for withdrawing one unfinished user round.
 * Git's index is backed up separately. Mutable Git metadata is fingerprinted and its changes
 * disable withdrawal; ordinary object storage and external symlink targets are never traversed.
 * Capture errors are durable and disable withdrawal without preventing normal task execution.
 */
export class WithdrawalSnapshotStore {
  private readonly records = new Map<string, StoredSnapshotRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly deletedSessions = new Set<string>();
  private readonly invalidatedRuns = new Set<string>();
  private readonly availableChunks = new Set<string>();
  constructor(private readonly root: string, private readonly crypto: VaultCrypto) {}

  async begin(run: RunIdentity, resumed = false): Promise<void> {
    return this.lock(join(this.root, "metadata-lock"), () => this.beginLocked(run, resumed));
  }
  private async beginLocked(run: RunIdentity, resumed: boolean): Promise<void> {
    if (this.invalidatedRuns.has(run.id) || this.deletedSessions.has(run.sessionId)) {
      this.invalidatedRuns.add(run.id);
      return;
    }
    let record: StoredSnapshotRecord = {
      version: 1, runId: run.id, sessionId: run.sessionId,
      workspacePath: resolve(run.workspacePath), captureRoot: resolve(run.workspacePath), status: "capturing", owner: "capturing",
    };
    try {
      const prior = await this.load(run.id);
      if (prior) {
        record = prior;
        if (record.sessionId !== run.sessionId || !samePath(record.workspacePath, run.workspacePath))
          throw new Error("撤回快照与任务或工作区不匹配");
        record.owner = "capturing";
        if (record.status === "unavailable" || record.status === "restoring" || record.status === "rolled_back") {
          await this.markOverlaps(record);
          await this.save(record);
          return;
        }
        record.status = "capturing";
        delete record.end;
        await this.markOverlaps(record);
        await this.save(record);
        return;
      }
      if (resumed) throw new Error("本轮没有发送前的完整文件快照，不能安全撤回");
      const workspace = await realpath(run.workspacePath);
      const repository = await this.gitLocation(workspace);
      record.captureRoot = repository?.root ?? workspace;
      if (!within(record.captureRoot, workspace)) throw new Error("工作区不在快照目录内");
      if (within(record.captureRoot, resolve(this.root))) throw new Error("撤回备份目录必须位于工作区外");
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (within(record.captureRoot, await realpath(this.root))) throw new Error("撤回备份目录必须位于工作区外");
      await this.save(record);
      await this.markOverlaps(record);
      if (record.status === "unavailable") return;
      record.before = await this.capture(record.captureRoot, true);
      await this.save(record);
    } catch (error) {
      record.status = "unavailable";
      record.reason = message(error);
      delete record.end;
      this.records.set(run.id, record);
      await this.save(record).catch(() => { /* Failed backups must never stop normal runs. */ });
    }
  }

  async finish(runId: string, paused: boolean): Promise<void> {
    return this.lock(join(this.root, "metadata-lock"), () => this.finishLocked(runId, paused));
  }
  private async finishLocked(runId: string, paused: boolean): Promise<void> {
    let record: StoredSnapshotRecord | undefined;
    try {
      record = await this.load(runId);
      if (!record) return;
      if (!paused) { await this.discardLocked([runId]); return; }
      record.owner = "paused";
      if (record.status !== "capturing" || !record.before) { await this.save(record); return; }
      await this.checkRoot(record);
      record.end = await this.capture(record.captureRoot, true);
      if (record.before.rootIdentity !== record.end.rootIdentity) throw new Error("本轮的工作区根目录已被替换，不能安全撤回");
      if (gitIdentity(record.before.git, false) !== gitIdentity(record.end.git, false))
        throw new Error("本轮改变了 Git 仓库或 HEAD，不能自动撤回文件");
      if (record.before.git?.metadataFingerprint !== record.end.git?.metadataFingerprint)
        throw new Error("本轮改变了 Git 配置、引用或其他元数据，无法完整撤回文件");
      record.status = "paused";
      await this.save(record);
    } catch (error) {
      if (!record) return;
      record.status = "unavailable";
      record.reason = message(error);
      delete record.end;
      this.records.set(runId, record);
      await this.save(record).catch(() => { /* Preserve normal pause even when capture fails. */ });
    }
  }

  async rootFor(runId: string): Promise<string> {
    const record = await this.load(runId);
    if (!record) throw new Error("本轮没有可用的撤回文件快照");
    return record.captureRoot;
  }

  async beginMessage(runId: string, messageId: string): Promise<void> {
    if (!messageId) throw new Error("撤回消息标识不能为空");
    const prior = await this.load(runId);
    if (!prior) throw new Error("本轮没有可用的撤回文件快照");
    return this.lock(prior.captureRoot, () => this.lock(join(this.root, "metadata-lock"), async () => {
      const record = await this.load(runId);
      if (!record || record.status !== "paused" || !record.before || !record.end)
        throw new Error(record?.reason ?? "本轮没有完整的暂停文件快照，不能安全发送可撤回消息");
      if (Object.hasOwn(record.messageBoundaries ?? {}, messageId)) throw new Error("消息撤回边界已存在");
      await this.checkRoot(record);
      // Keep whole-round rollback semantics: edits made by the user after pausing are never
      // silently absorbed into this run's changes. Capture actual bytes and compare the whole end.
      const boundary = await this.capture(record.captureRoot, true);
      this.assertFrozenEnd(record.end, boundary);
      const boundaries = { ...record.messageBoundaries, [messageId]: boundary };
      const saved = { ...record, messageBoundaries: boundaries };
      await this.save(saved);
    }));
  }

  async cancelMessage(runId: string, messageId: string): Promise<void> {
    return this.lock(join(this.root, "metadata-lock"), async () => {
      const record = await this.load(runId);
      if (!record || !Object.hasOwn(record.messageBoundaries ?? {}, messageId)) return;
      const boundaries = { ...record.messageBoundaries };
      delete boundaries[messageId];
      await this.save({ ...record, messageBoundaries: boundaries });
      await this.garbageCollect();
    });
  }

  async rollback<T>(runId: string, commit: () => T): Promise<T> {
    return this.rollbackTo(runId, undefined, commit);
  }

  async rollbackMessage<T>(runId: string, messageId: string, commit: () => T): Promise<T> {
    if (!messageId) throw new Error("撤回消息标识不能为空");
    return this.rollbackTo(runId, messageId, commit);
  }

  private assertFrozenEnd(end: Snapshot, current: Snapshot): void {
    const conflicts = differences(end, current);
    if (end.rootMode !== current.rootMode) conflicts.push("工作区根目录权限");
    if (end.rootIdentity !== current.rootIdentity) conflicts.push("工作区根目录身份");
    if (gitIdentity(end.git, true) !== gitIdentity(current.git, true)) conflicts.push("Git HEAD / 暂存区");
    if (conflicts.length) throw new Error(`暂停后文件发生变化，撤回冲突：${conflicts.slice(0, 5).join("、")}`);
  }

  private async rollbackTo<T>(runId: string, messageId: string | undefined, commit: () => T): Promise<T> {
    const prior = await this.load(runId);
    if (!prior) throw new Error("本轮没有可用的撤回文件快照");
    return this.lock(prior.captureRoot, () => this.lock(join(this.root, "metadata-lock"), async () => {
      const record = await this.load(runId);
      if (!record || record.status !== "paused" || !record.before || !record.end)
        throw new Error(record?.reason ?? "本轮没有完整的暂停文件快照，不能安全撤回");
      const target = messageId === undefined ? record.before
        : Object.hasOwn(record.messageBoundaries ?? {}, messageId) ? record.messageBoundaries![messageId] : undefined;
      if (!target) throw new Error("这条消息没有发送前的完整文件快照，不能安全撤回");
      await this.checkRoot(record);
      const current = await this.capture(record.captureRoot, false);
      this.assertFrozenEnd(record.end, current);
      const changed = differences(target, record.end);
      await this.validateRestoration(record.captureRoot, target, record.end, changed);
      // All restore and compensation bytes are authenticated before touching a workspace file.
      await this.verifyBytes(target, changed);
      await this.verifyBytes(record.end, changed);
      const afterPreflight = await this.capture(record.captureRoot, false);
      if (differences(record.end, afterPreflight).length || record.end.rootMode !== afterPreflight.rootMode || record.end.rootIdentity !== afterPreflight.rootIdentity || gitIdentity(record.end.git, true) !== gitIdentity(afterPreflight.git, true))
        throw new Error("文件在撤回检查期间发生变化，请保留本轮并检查工作区");
      record.status = "restoring";
      await this.save(record);
      const state: RestorationState = { entries: new Map(Object.entries(record.end.entries)), rootMode: record.end.rootMode, rootIdentity: record.end.rootIdentity, index: record.end.git?.index };
      let applied = false;
      try {
        applied = true;
        await this.restore(record.captureRoot, target, record.end, changed, state);
        const restored = await this.capture(record.captureRoot, false);
        if (differences(target, restored).length || target.rootMode !== restored.rootMode || target.rootIdentity !== restored.rootIdentity || gitIdentity(target.git, true) !== gitIdentity(restored.git, true))
          throw new Error("文件恢复校验失败");
        const result = commit();
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new Error("撤回数据库提交必须同步执行");
        if (messageId === undefined) {
          record.status = "rolled_back";
          delete record.owner;
        } else {
          record.status = "paused";
          record.owner = "paused";
          record.end = target;
          const boundaries: Record<string, Snapshot> = {};
          for (const [id, boundary] of Object.entries(record.messageBoundaries ?? {})) {
            if (id === messageId) break;
            boundaries[id] = boundary;
          }
          record.messageBoundaries = boundaries;
        }
        // Database commit has succeeded; bookkeeping errors must not compensate committed deletion.
        this.records.set(runId, record);
        await this.save(record).catch(() => {});
        return result;
      } catch (error) {
        if (applied) {
          try {
            // Only restore paths belonging to this operation; concurrent unrelated edits are not overwritten.
            await this.restore(record.captureRoot, record.end, target, changed, state);
            const compensated = await this.capture(record.captureRoot, false);
            if (differences(record.end, compensated).length || record.end.rootMode !== compensated.rootMode || record.end.rootIdentity !== compensated.rootIdentity || gitIdentity(record.end.git, true) !== gitIdentity(compensated.git, true))
              throw new Error("补偿后的工作区与暂停状态不一致");
          } catch (compensation) {
            record.status = "unavailable";
            record.reason = `文件撤回失败且补偿未完成；已保留聊天及加密备份：${message(compensation)}`;
            await this.save(record).catch(() => {});
            throw new Error(`${message(error)}；${record.reason}`);
          }
        }
        record.status = "paused";
        await this.save(record).catch(() => {});
        throw error;
      }
    }));
  }

  async discard(runIds: string[]): Promise<void> {
    return this.lock(join(this.root, "metadata-lock"), () => this.discardLocked(runIds));
  }
  private async discardLocked(runIds: string[]): Promise<void> {
    for (const id of runIds) {
      this.records.delete(id);
      try { await unlink(this.recordPath(id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await this.garbageCollect();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    return this.lock(join(this.root, "metadata-lock"), async () => {
      const records = await this.allRecords();
      const ids = records.filter(record => record.sessionId === sessionId).map(record => record.runId);
      for (const id of ids) this.invalidatedRuns.add(id);
      await this.discardLocked(ids);
    });
  }

  restoreSession(sessionId: string): void { this.deletedSessions.delete(sessionId); }

  private async allRecords(): Promise<StoredSnapshotRecord[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...this.records.values()]; throw error; }
    const found = new Map(this.records);
    for (const name of names.filter(name => name.endsWith(".snapshot"))) {
      const record = this.crypto.decryptJson<StoredSnapshotRecord>(await readFile(join(this.root, name), "utf8"), RECORD_AAD);
      if (record.version !== 1 || !record.runId || !samePath(this.recordPath(record.runId), join(this.root, name)))
        throw new Error("撤回快照身份无效");
      if (!found.has(record.runId)) found.set(record.runId, record);
    }
    return [...found.values()];
  }

  private async markOverlaps(record: StoredSnapshotRecord): Promise<void> {
    for (const other of await this.allRecords()) {
      if (other.runId === record.runId || !other.owner || !record.owner) continue;
      if (!within(record.captureRoot, other.captureRoot) && !within(other.captureRoot, record.captureRoot)) continue;
      const reason = "工作区存在同时或中途运行的其他对话，无法安全区分本轮文件修改";
      record.status = "unavailable"; record.reason = reason;
      other.status = "unavailable"; other.reason = reason;
      await this.save(other);
    }
  }

  private async garbageCollect(): Promise<void> {
    const used = new Set<string>();
    for (const record of await this.allRecords()) {
      for (const snapshot of [record.before, record.end, ...Object.values(record.messageBoundaries ?? {})]) {
        if (!snapshot) continue;
        for (const entry of Object.values(snapshot.entries)) if (entry.kind === "file") for (const id of entry.chunks) used.add(id);
        for (const id of snapshot.git?.index?.chunks ?? []) used.add(id);
      }
    }
    const chunks = join(this.root, "chunks");
    let prefixes: string[];
    try { prefixes = await readdir(chunks); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; prefixes = []; }
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const directory = join(chunks, prefix);
      for (const name of await readdir(directory)) {
        const match = /^([a-f0-9]{64})\.chunk$/.exec(name);
        if (match && !used.has(match[1]!)) { await unlink(join(directory, name)); this.availableChunks.delete(match[1]!); }
      }
      await rmdir(directory).catch(error => { if (!["ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
    }
    for (const directory of [chunks, this.root]) await rmdir(directory).catch(error => {
      if (!["ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    });
  }

  private async checkRoot(record: StoredSnapshotRecord): Promise<void> {
    if (!samePath(await realpath(record.captureRoot), record.captureRoot)) throw new Error("工作区根目录已改变");
    const workspace = await realpath(record.workspacePath);
    if (!within(record.captureRoot, workspace)) throw new Error("工作区已移出文件快照目录");
    if (within(record.captureRoot, resolve(this.root))) throw new Error("撤回备份目录位于工作区内");
  }

  private async gitLocation(root: string): Promise<GitLocation | undefined> {
    let repository: string;
    try {
      const result = await execute("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-path", "index", "--git-common-dir"],
        { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
      const lines = result.stdout.trim().split(/\r?\n/);
      if (lines.length !== 4) throw new Error("无法完整读取 Git 仓库路径");
      repository = await realpath(lines[0]!);
      const directory = await realpath(lines[1]!);
      const indexPath = resolve(lines[2]!);
      const commonDirectory = await realpath(lines[3]!);
      if (!within(directory, indexPath)) throw new Error("Git index 位于仓库元数据目录外");
      const reference = (await readFile(join(directory, "HEAD"), "utf8")).trim();
      let head: string;
      try { head = (await execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim(); }
      catch {
        if (!/^ref: refs\/heads\/[^\r\n]+$/.test(reference)) throw new Error("Git HEAD 无效");
        head = "unborn";
      }
      return { root: repository, directory, commonDirectory, indexPath, head: `${head}:${reference}` };
    } catch {
      // A failed metadata read inside a repository must not silently become a non-Git snapshot.
      let ancestor = root;
      for (;;) {
        try { await lstat(join(ancestor, ".git")); throw new Error("无法检查现有 Git 仓库"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const parent = dirname(ancestor);
        if (samePath(parent, ancestor)) break;
        ancestor = parent;
      }
      try {
        await execute("git", ["rev-parse", "--show-toplevel"], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
      } catch { return undefined; }
      throw new Error("无法检查现有 Git 仓库");
    }
  }

  /** Fingerprint configuration, refs, hooks, logs and shared worktree metadata without backing
   * up the object database. Git's own diff capture writes ordinary objects; objects/info remains
   * included because alternates and similar files change repository behavior. */
  private async gitMetadata(location: GitLocation): Promise<string> {
    const fingerprints: Array<[string, string]> = [];
    const roots = samePath(location.directory, location.commonDirectory)
      ? [location.directory] : [location.directory, location.commonDirectory];
    for (const metadataRoot of roots) {
      const walk = async (directory: string, prefix: string): Promise<void> => {
        const parent = await lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || !within(metadataRoot, await realpath(directory)))
          throw new Error("Git 元数据目录链路不安全");
        fingerprints.push([`${metadataRoot}:${prefix}`, `directory:${mode(parent)}${prefix ? "" : `:${rootIdentity(parent)}`}`]);
        const children = (await readdir(directory)).sort();
        for (const child of children) {
          const absolute = join(directory, child);
          const path = prefix ? `${prefix}/${child}` : child;
          if (samePath(absolute, location.indexPath) || samePath(absolute, `${location.indexPath}.lock`)) continue;
          // Ordinary loose objects and packs are append-only storage used by the review service.
          if (samePath(directory, join(location.commonDirectory, "objects")) && child !== "info") continue;
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) throw new Error(`Git 元数据包含外部链接，无法安全撤回：${path}`);
          if (info.isDirectory()) await walk(absolute, path);
          else if (info.isFile()) fingerprints.push([`${metadataRoot}:${path}`, identity(await this.file(absolute, false))]);
          else throw new Error(`Git 元数据包含无法检查的特殊节点：${path}`);
        }
        if (!sameLinkStat(parent, await lstat(directory))) throw new Error("捕获期间 Git 元数据目录被替换");
        const filtered = (names: string[]) => names.filter(child => {
          const absolute = join(directory, child);
          return !samePath(absolute, location.indexPath) && !samePath(absolute, `${location.indexPath}.lock`)
            && (!samePath(directory, join(location.commonDirectory, "objects")) || child === "info");
        });
        if (JSON.stringify(filtered(children)) !== JSON.stringify(filtered((await readdir(directory)).sort())))
          throw new Error("捕获期间 Git 元数据内容发生变化");
      };
      await walk(metadataRoot, "");
    }
    return hash(JSON.stringify(fingerprints));
  }

  private async gitState(root: string, saveBytes: boolean): Promise<GitState | undefined> {
    const location = await this.gitLocation(root);
    if (!location) return undefined;
    try { await lstat(`${location.indexPath}.lock`); throw new Error("Git 暂存区正在被修改"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let index: FileEntry | null;
    try {
      const info = await lstat(location.indexPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Git index 不是普通文件");
      index = await this.file(location.indexPath, saveBytes);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; index = null; }
    return { ...location, metadataFingerprint: await this.gitMetadata(location), index };
  }

  private async capture(root: string, saveBytes: boolean): Promise<Snapshot> {
    if (!samePath(await realpath(root), root)) throw new Error("文件快照目录是替换后的链接");
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("文件快照根目录无效");
    const beforeGit = await this.gitState(root, saveBytes);
    if (beforeGit && !samePath(beforeGit.root, root)) throw new Error("文件快照必须覆盖完整仓库根目录");
    const entries: { [path: string]: Entry } = Object.create(null) as { [path: string]: Entry };
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !within(root, await realpath(directory)))
        throw new Error("文件快照目录链路不安全");
      const children = (await readdir(directory)).sort();
      for (const child of children) {
        const path = prefix ? `${prefix}/${child}` : child;
        if (child === ".git") {
          if (!prefix && beforeGit) continue;
          throw new Error(`工作区包含嵌套 Git 仓库：${path}`);
        }
        const absolute = join(directory, child);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          let linkType: LinkEntry["linkType"] = "file";
          try { if ((await stat(absolute)).isDirectory()) linkType = process.platform === "win32" ? "junction" : "dir"; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const target = await readlink(absolute);
          entries[path] = { kind: "link", mode: mode(info), target, linkType };
          if (!sameLinkStat(info, await lstat(absolute)) || target !== await readlink(absolute)) throw new Error(`捕获期间链接发生变化：${path}`);
        } else if (info.isDirectory()) {
          entries[path] = { kind: "directory", mode: mode(info) };
          await walk(absolute, path);
        } else if (info.isFile()) entries[path] = await this.file(absolute, saveBytes);
        else throw new Error(`工作区包含无法恢复的特殊节点：${path}`);
      }
      if (!sameLinkStat(parent, await lstat(directory))) throw new Error("捕获期间目录被替换");
      if (JSON.stringify(children) !== JSON.stringify((await readdir(directory)).sort())) throw new Error("捕获期间目录内容发生变化");
    };
    await walk(root, "");
    const afterGit = await this.gitState(root, saveBytes);
    if (gitIdentity(beforeGit, true) !== gitIdentity(afterGit, true)) throw new Error("捕获期间 Git 仓库或暂存区发生变化");
    if (!sameLinkStat(rootInfo, await lstat(root))) throw new Error("捕获期间工作区根目录被替换");
    return { entries, rootMode: mode(rootInfo), rootIdentity: rootIdentity(rootInfo), ...(afterGit ? { git: afterGit } : {}) };
  }

  private async file(path: string, saveBytes: boolean): Promise<FileEntry> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("备份目标不是普通文件");
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      if (!sameLinkStat(before, await handle.stat())) throw new Error("捕获期间文件被替换");
      const digest = createHash("sha256");
      const chunks: string[] = [];
      let size = 0;
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, Math.max(1, before.size)));
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
        digest.update(bytes);
        size += bytesRead;
        if (saveBytes) chunks.push(await this.putChunk(bytes));
      }
      const after = await handle.stat();
      if (!sameLinkStat(before, after) || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size
        || !sameLinkStat(after, await lstat(path))) throw new Error("捕获期间文件内容发生变化");
      return { kind: "file", mode: mode(before), size, links: before.nlink, hash: digest.digest("hex"), chunks };
    } finally { await handle.close(); }
  }

  private async putChunk(bytes: Buffer): Promise<string> {
    const id = this.crypto.contentAddress(`withdrawal-chunk:${hash(bytes)}`);
    if (this.availableChunks.has(id)) return id;
    const path = this.chunkPath(id);
    try { await lstat(path); this.availableChunks.add(id); return id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, this.crypto.encryptBuffer(bytes, `withdrawal-chunk:${id}`), { mode: 0o600 });
      await rename(temporary, path);
      this.availableChunks.add(id);
    } finally { await unlink(temporary).catch(() => {}); }
    return id;
  }

  private chunkPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("非法撤回备份块");
    return join(this.root, "chunks", id.slice(0, 2), `${id}.chunk`);
  }
  private async chunk(id: string): Promise<Buffer> {
    const bytes = this.crypto.decryptBuffer(await readFile(this.chunkPath(id)), `withdrawal-chunk:${id}`);
    if (this.crypto.contentAddress(`withdrawal-chunk:${hash(bytes)}`) !== id) throw new Error("撤回备份块内容校验失败");
    return bytes;
  }

  private async verifyFile(entry: FileEntry): Promise<void> {
    const digest = createHash("sha256");
    let size = 0;
    for (const id of entry.chunks) { const bytes = await this.chunk(id); digest.update(bytes); size += bytes.length; }
    if (size !== entry.size || digest.digest("hex") !== entry.hash) throw new Error("撤回文件备份不完整或已损坏");
  }
  private async verifyBytes(snapshot: Snapshot, changed: string[]): Promise<void> {
    for (const path of changed) {
      const entry = snapshot.entries[path];
      if (entry?.kind === "file") await this.verifyFile(entry);
    }
    if (snapshot.git?.index) await this.verifyFile(snapshot.git.index);
  }

  private validate(path: string): void {
    if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))
      throw new Error("非法撤回文件路径");
  }
  private async safePath(root: string, path: string, allowMissing = false): Promise<string> {
    if (!samePath(await realpath(root), root) || !(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
      throw new Error("撤回期间工作区根目录发生变化");
    this.validate(path);
    const absolute = resolve(root, ...path.split("/"));
    if (!within(root, absolute) || samePath(root, absolute)) throw new Error("撤回文件路径越出工作区");
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      try {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("撤回文件祖先目录被替换为链接或文件");
      } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
    return absolute;
  }
  private async validateRestoration(root: string, before: Snapshot, end: Snapshot, changed: string[]): Promise<void> {
    if (before.rootIdentity !== end.rootIdentity) throw new Error("本轮的工作区根目录已被替换，不能安全撤回");
    for (const snapshot of [before, end]) {
      if (!Number.isInteger(snapshot.rootMode)) throw new Error("快照缺少工作区根目录权限，无法完整恢复");
      if (!snapshot.rootIdentity) throw new Error("快照缺少工作区根目录身份，无法完整恢复");
      if (snapshot.git && (!snapshot.git.commonDirectory || !snapshot.git.metadataFingerprint))
        throw new Error("快照缺少完整 Git 元数据指纹，无法安全撤回");
      for (const [path, entry] of Object.entries(snapshot.entries)) {
        this.validate(path);
        if (!["file", "directory", "link"].includes(entry.kind)) throw new Error("快照包含非法文件类型");
        for (let parent = path.slice(0, path.lastIndexOf("/")); path.includes("/") && parent; parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "")
          if (snapshot.entries[parent]?.kind !== "directory") throw new Error("快照的文件祖先目录不完整");
      }
    }
    for (const path of changed) {
      for (const entry of [before.entries[path], end.entries[path]])
        if (entry?.kind === "file" && (!Number.isInteger(entry.links) || entry.links > 1))
          throw new Error(`修改文件存在工作区外硬链接，无法安全恢复：${path}`);
      // A directory/file type change is owned by this operation and is handled before child restoration.
      try { await this.safePath(root, path, true); }
      catch (error) {
        const ancestors = path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
        if (!ancestors.some(parent => changed.includes(parent) && end.entries[parent]?.kind !== "directory")) throw error;
      }
      for (const entry of [before.entries[path], end.entries[path]]) {
        if (entry?.kind !== "link" || identity(before.entries[path]) === identity(end.entries[path])) continue;
        const temporary = join(this.root, `${randomUUID()}.link-check`);
        const target = process.platform === "win32" && entry.linkType === "junction"
          ? resolve(dirname(resolve(root, ...path.split("/"))), entry.target) : entry.target;
        try { await symlink(target, temporary, entry.linkType); }
        finally { await unlink(temporary).catch(() => {}); }
      }
    }
  }

  private async existingEntry(path: string): Promise<Entry | undefined> {
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) return { kind: "directory", mode: mode(info) };
      if (info.isFile() && !info.isSymbolicLink()) return this.file(path, false);
      if (info.isSymbolicLink()) {
        let linkType: LinkEntry["linkType"] = "file";
        try { if ((await stat(path)).isDirectory()) linkType = process.platform === "win32" ? "junction" : "dir"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return { kind: "link", mode: mode(info), target: await readlink(path), linkType };
      }
      throw new Error("撤回期间文件被替换为特殊节点");
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
  }

  private async assertRoot(root: string, state: RestorationState, checkMode = true) {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootIdentity(rootInfo) !== state.rootIdentity || !samePath(await realpath(root), root))
      throw new Error("撤回期间工作区根目录发生变化");
    const verified = await lstat(root);
    if (!sameLinkStat(rootInfo, verified) || rootIdentity(verified) !== state.rootIdentity)
      throw new Error("撤回期间工作区根目录发生变化");
    if (checkMode && mode(verified) !== state.rootMode) throw new Error("撤回期间工作区根目录权限发生变化");
    return verified;
  }

  private async assertCurrent(root: string, path: string, state: RestorationState): Promise<string | undefined> {
    await this.assertRoot(root, state);
    this.validate(path);
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      const actual = await this.existingEntry(resolve(root, ...parts.slice(0, count)));
      if (identity(actual) !== identity(state.entries.get(parent))) throw new Error(`撤回期间目录发生变化：${parent}`);
      if (actual?.kind !== "directory") { await this.assertRoot(root, state); return undefined; }
    }
    const absolute = resolve(root, ...parts);
    if (!within(root, absolute) || samePath(root, absolute)) throw new Error("撤回文件越出工作区");
    if (identity(await this.existingEntry(absolute)) !== identity(state.entries.get(path))) throw new Error(`撤回期间文件发生变化：${path}`);
    await this.assertRoot(root, state);
    return absolute;
  }

  private async restore(root: string, desired: Snapshot, source: Snapshot, changed: string[], state: RestorationState): Promise<void> {
    await this.assertRoot(root, state);
    await chmod(root, state.rootMode | 0o700);
    state.rootMode = mode(await this.assertRoot(root, state, false));
    const depth = (path: string) => path.split("/").length;
    const directories = new Set<string>();
    for (const path of changed) {
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
      if (source.entries[path]?.kind === "directory" || desired.entries[path]?.kind === "directory") directories.add(path);
    }
    for (const path of [...directories].sort((a, b) => depth(a) - depth(b))) {
      const absolute = await this.assertCurrent(root, path, state);
      const entry = state.entries.get(path);
      if (absolute && entry?.kind === "directory") {
        await chmod(absolute, entry.mode | 0o700);
        await this.assertRoot(root, state);
        state.entries.set(path, { kind: "directory", mode: mode(await lstat(absolute)) });
      }
    }
    for (const path of [...changed].sort((a, b) => depth(b) - depth(a))) {
      const target = desired.entries[path];
      const old = state.entries.get(path);
      if (old?.kind === "directory" && target?.kind === "directory") continue;
      const absolute = await this.assertCurrent(root, path, state);
      if (!absolute || !old) continue;
      if (old.kind === "directory") await rmdir(absolute);
      else {
        if (old.kind === "file") {
          await chmod(absolute, old.mode | 0o600);
          await this.assertRoot(root, state);
          state.entries.set(path, { ...old, mode: mode(await lstat(absolute)) });
          await this.assertCurrent(root, path, state);
        }
        await unlink(absolute);
      }
      state.entries.delete(path);
    }
    for (const path of [...changed].sort((a, b) => depth(a) - depth(b))) {
      const entry = desired.entries[path];
      if (!entry) continue;
      const absolute = await this.assertCurrent(root, path, state);
      if (!absolute) throw new Error(`恢复文件缺少安全父目录：${path}`);
      if (entry.kind === "directory") {
        if (!state.entries.has(path)) await mkdir(absolute, { recursive: false, mode: entry.mode | 0o700 });
        await this.assertRoot(root, state);
        state.entries.set(path, { kind: "directory", mode: mode(await lstat(absolute)) });
      }
      else if (entry.kind === "link") await symlink(entry.target, absolute, entry.linkType);
      else await this.writeRestoredFile(absolute, entry, () => this.assertRoot(root, state).then(() => undefined));
      if (entry.kind !== "directory") state.entries.set(path, entry);
    }
    for (const path of [...directories].sort((a, b) => depth(b) - depth(a))) {
      const entry = desired.entries[path];
      if (entry?.kind === "directory") {
        const absolute = await this.assertCurrent(root, path, state);
        if (!absolute) throw new Error(`恢复目录缺少安全父目录：${path}`);
        await chmod(absolute, entry.mode); state.entries.set(path, entry);
      }
    }
    const git = desired.git;
    if (git && identity(git.index ?? undefined) !== identity(state.index ?? undefined)) {
      await this.assertRoot(root, state);
      const currentGit = await this.gitLocation(root);
      if (gitIdentity(git, false) !== gitIdentity(currentGit ? { ...currentGit, index: null } : undefined, false))
        throw new Error("撤回期间 Git HEAD 或仓库发生变化");
      const actualIndex = await this.gitState(root, false);
      if (git.metadataFingerprint !== actualIndex?.metadataFingerprint) throw new Error("撤回期间 Git 元数据发生变化");
      if (identity(actualIndex?.index ?? undefined) !== identity(state.index ?? undefined)) throw new Error("撤回期间 Git 暂存区发生变化");
      await this.assertRoot(root, state);
      const indexLock = `${git.indexPath}.lock`;
      const handle = await open(indexLock, "wx", 0o600);
      try {
        await handle.close();
        if (state.index) {
          const info = await lstat(git.indexPath);
          if (info.nlink > 1 || !info.isFile() || info.isSymbolicLink()) throw new Error("Git index 存在硬链接或文件类型变化，无法安全恢复");
          await chmod(git.indexPath, mode(info) | 0o600);
          await this.assertRoot(root, state);
          state.index = { ...state.index, mode: mode(await lstat(git.indexPath)) };
        }
        if (git.index) {
          await this.writeRestoredFile(indexLock, git.index, () => this.assertRoot(root, state).then(() => undefined));
          await this.assertRoot(root, state);
          await rename(indexLock, git.indexPath);
        }
        else await unlink(git.indexPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        state.index = git.index;
      } finally { await handle.close().catch(() => {}); await unlink(indexLock).catch(() => {}); }
    }
    await this.assertRoot(root, state);
    await chmod(root, desired.rootMode);
    state.rootMode = mode(await this.assertRoot(root, state, false));
  }

  private async writeRestoredFile(path: string, entry: FileEntry, assertRoot: () => Promise<void>): Promise<void> {
    await assertRoot();
    const temporary = join(dirname(path), `.withdrawal-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      const digest = createHash("sha256");
      let size = 0;
      for (const id of entry.chunks) {
        const bytes = await this.chunk(id);
        digest.update(bytes); size += bytes.length;
        await handle.writeFile(bytes);
      }
      if (size !== entry.size || digest.digest("hex") !== entry.hash) throw new Error("恢复文件备份校验失败");
      await handle.sync();
      await handle.close();
      await assertRoot();
      await chmod(temporary, entry.mode);
      await assertRoot();
      await rename(temporary, path);
    } finally {
      await handle.close().catch(() => {});
      // A replaced root may contain another owner's file at this path; do not clean through it.
      try { await assertRoot(); await unlink(temporary); } catch { /* The failed restore retains encrypted recovery bytes. */ }
    }
  }

  private recordPath(id: string): string { return join(this.root, `${this.crypto.contentAddress(`withdrawal-record:${id}`)}.snapshot`); }
  private async load(id: string): Promise<StoredSnapshotRecord | undefined> {
    const memory = this.records.get(id);
    if (memory) return memory;
    try {
      const record = this.crypto.decryptJson<StoredSnapshotRecord>(await readFile(this.recordPath(id), "utf8"), RECORD_AAD);
      if (record.version !== 1 || record.runId !== id) throw new Error("撤回快照版本或身份无效");
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async save(record: StoredSnapshotRecord): Promise<void> {
    if (this.deletedSessions.has(record.sessionId) || this.invalidatedRuns.has(record.runId)) {
      this.records.delete(record.runId);
      return;
    }
    this.records.set(record.runId, record);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.recordPath(record.runId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, this.crypto.encryptJson(record, RECORD_AAD), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async lock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
    const previous = this.locks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolveLock => { release = resolveLock; });
    this.locks.set(key, current);
    if (previous) await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}

function sameLinkStat(left: { dev: number; ino: number; mode: number }, right: { dev: number; ino: number; mode: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
