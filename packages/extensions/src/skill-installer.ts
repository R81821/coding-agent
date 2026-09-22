import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { SkillPreview } from "@harness/protocol";
import { SkillService, type SkillDocument } from "./skills.js";

export interface GitHubSkillSource { owner: string; repo: string; tree: string[]; skill?: string }
export function parseSkillCommand(command: string): GitHubSkillSource {
  const input = command.trim();
  if (!input || /[\r\n;&|`$<>\\]/.test(input)) throw new Error("仅支持单条 npx skills add GitHub 安装命令，不能串联脚本");
  const tokens = input.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g)?.map(value => value.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  if (tokens.slice(0, 3).join(" ") !== "npx skills add" || !tokens[3]) throw new Error("命令格式：npx skills add owner/repo --skill skill-name -g");
  // Quotes may only surround a whole token.
  if ((input.match(/["']/g)?.length ?? 0) % 2) throw new Error("命令引号不完整");
  const source = parseGitHubSource(tokens[3]);
  let global = false;
  for (let i = 4; i < tokens.length; i++) {
    const arg = tokens[i];
    if ((arg === "-g" || arg === "--global") && !global) global = true;
    else if (arg === "--skill" && !source.skill) {
      const skill = tokens[++i];
      if (!skill || !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,127}$/u.test(skill) || skill.includes("..")) throw new Error("无效的 --skill 名称");
      source.skill = skill;
    } else throw new Error(`不支持的参数：${arg}`);
  }
  return source;
}

export function parseGitHubSource(source: string): GitHubSkillSource {
  let parts: string[];
  if (source.startsWith("https://")) {
    const url = new URL(source);
    if (url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) throw new Error("首版仅支持公开 GitHub HTTPS 来源");
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } else parts = source.split("/");
  const [owner, rawRepo, kind, ...tree] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[a-zA-Z0-9_-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo) || repo === "." || repo === ".." || (kind && (kind !== "tree" || !tree.length))) throw new Error("无效的 GitHub 仓库或技能子目录地址");
  tree.forEach(safeSegment);
  return { owner, repo, tree };
}

function safeSegment(segment: string): void {
  if (!segment || /[\\/:<>"|?*\x00-\x1f]/.test(segment) || segment === "." || segment === ".." || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error(`不安全的资源路径：${segment}`);
}
interface TreeEntry { path: string; type: string; mode: string; sha: string; size?: number }
interface Snapshot { preview: SkillPreview; source: GitHubSkillSource; tree: TreeEntry[]; createdAt: number }
interface Installation { revision: string; source: string }
const MAX_BYTES = 25 * 1024 * 1024;

export class SkillInstaller {
  private snapshots = new Map<string, Snapshot>();
  private installing = new Set<string>();
  constructor(private readonly skills: SkillService, private readonly fetcher: typeof fetch = fetch, private readonly token?: string) {}

  async request(url: string, signal?: AbortSignal): Promise<Response> {
    const combined = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const response = await this.fetcher(url, {
      signal: combined,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Harness-Skills",
        // Unauthenticated GitHub allows 60 requests an hour, which one skill search exhausts. A token
        // raises that to 5000 and is the difference between discovery working and always rate limiting.
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) {
      const limited = response.status === 403 || response.status === 429;
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const detail = limited
        ? `：访问限流${remaining === "0" && Number.isFinite(reset) ? `，配额将于 ${new Date(reset * 1000).toLocaleTimeString()} 重置` : "，请稍后重试"}${this.token ? "" : "；配置 GitHub Token 可将额度从 60 次/小时提升到 5000 次/小时"}`
        : "";
      throw Object.assign(new Error(`GitHub 请求失败 (${response.status})${detail}`), { status: response.status });
    }
    return response;
  }

  async search(query: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} skill`)}&per_page=10`, signal);
    const data = await response.json() as { items?: Array<{ full_name: string; description: string; html_url: string }> };
    return (data.items ?? []).map(item => ({ repository: item.full_name, description: item.description, url: item.html_url }));
  }

  async preview(command: string, signal?: AbortSignal, progress: (value: string) => void = () => {}): Promise<SkillPreview> {
    signal?.throwIfAborted();
    const source = parseSkillCommand(command);
    const repoUrl = `https://api.github.com/repos/${source.owner}/${source.repo}`;
    progress("正在解析 GitHub 仓库版本…");
    let revision = "", subpath = "";
    if (source.tree.length) {
      for (let count = source.tree.length; count > 0; count--) {
        try {
          const data = await (await this.request(`${repoUrl}/commits/${encodeURIComponent(source.tree.slice(0, count).join("/"))}`, signal)).json() as { sha: string };
          revision = data.sha; subpath = source.tree.slice(count).join("/"); break;
        } catch (error) { if ((error as { status?: number }).status !== 404 && (error as { status?: number }).status !== 422) throw error; }
      }
    } else revision = (await (await this.request(`${repoUrl}/commits/HEAD`, signal)).json() as { sha: string }).sha;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("找不到该仓库版本或子目录");
    const data = await (await this.request(`${repoUrl}/git/trees/${revision}?recursive=1`, signal)).json() as { tree: TreeEntry[]; truncated?: boolean };
    if (data.truncated) throw new Error("仓库文件树过大，GitHub 返回不完整，无法安全预览");
    const skillEntries = data.tree.filter(entry => entry.type === "blob" && /(^|\/)SKILL\.md$/.test(entry.path) && (!subpath || entry.path.startsWith(`${subpath}/`)));
    if (!skillEntries.length) throw new Error("该来源中没有找到 SKILL.md");
    if (skillEntries.length > 100) throw new Error("仓库包含超过 100 个技能，请使用技能子目录地址");
    const preview: SkillPreview = { id: randomUUID(), source: `https://github.com/${source.owner}/${source.repo}`, revision, globalPath: this.skills.userSkillRoot, skills: [] };
    for (const entry of skillEntries) {
      signal?.throwIfAborted();
      const path = entry.path === "SKILL.md" ? "" : entry.path.slice(0, -9);
      const content = (await this.download(source, revision, entry, signal)).toString("utf8");
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) continue;
      let meta: Record<string, unknown>;
      try { meta = YAML.parse(match[1]!) as Record<string, unknown>; }
      catch (error) {
        if (source.skill === path.split("/").at(-1)) throw new Error(`技能元数据无效：${path} (${String(error)})`);
        continue;
      }
      if (!meta || typeof meta.name !== "string" || typeof meta.description !== "string") continue;
      if (source.skill && meta.name !== source.skill && path.split("/").at(-1) !== source.skill) continue;
      const resources = this.resources(data.tree, path);
      const installationPath = this.target(source, path);
      const installed = await this.readInstallation(installationPath);
      preview.skills.push({ path, name: meta.name, description: meta.description, content, files: resources.map(file => path ? file.path.slice(path.length + 1) : file.path), installationPath: join(installationPath, "content"), ...(installed ? { installedRevision: installed.revision } : {}) });
      progress(`已验证 ${preview.skills.length} 个技能…`);
    }
    if (!preview.skills.length) throw new Error("没有找到匹配名称且具有有效元数据的 SKILL.md");
    for (const [id, snapshot] of this.snapshots) if (Date.now() - snapshot.createdAt > 3600_000) this.snapshots.delete(id);
    if (this.snapshots.size >= 30) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(preview.id, { preview, source, tree: data.tree, createdAt: Date.now() });
    return preview;
  }

  async install(id: string, path: string, replace: boolean, signal?: AbortSignal, progress: (value: string) => void = () => {}, save: (doc: SkillDocument) => void = () => {}): Promise<SkillDocument> {
    signal?.throwIfAborted();
    const snapshot = this.snapshots.get(id);
    const item = snapshot?.preview.skills.find(skill => skill.path === path);
    if (!snapshot || !item) throw new Error("预览已失效，请重新预览");
    const target = this.target(snapshot.source, path);
    if (this.installing.has(target)) throw new Error("该技能正在安装，请稍后重试");
    this.installing.add(target);
    const stage = join(dirname(this.skills.userSkillRoot), ".skill-staging", randomUUID());
    const backup = `${stage}-backup`;
    let backedUp = false, swapped = false, committed = false;
    try {
      const installed = await this.readInstallation(target);
      if (installed?.revision === snapshot.preview.revision) {
        // Never re-trust altered resources merely because origin metadata matches.
        throw new Error("该版本已安装；如需重新确认信任，请查看已安装技能");
      }
      if (installed && !replace) throw new Error("存在其他版本，请明确选择替换");
      const resources = this.resources(snapshot.tree, path);
      let count = 0;
      for (const resource of resources) {
        signal?.throwIfAborted();
        const relativePath = path ? resource.path.slice(path.length + 1) : resource.path;
        const destination = join(stage, "content", ...relativePath.split("/"));
        const bytes = await this.download(snapshot.source, snapshot.preview.revision, resource, signal);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        progress(`下载资源 ${++count}/${resources.length}`);
      }
      const checked = await this.skills.load(join(stage, "content", "SKILL.md"));
      await writeFile(join(stage, "installation.json"), JSON.stringify({ revision: snapshot.preview.revision, source: `${snapshot.preview.source}/${path}` }));
      signal?.throwIfAborted();
      await mkdir(this.skills.userSkillRoot, { recursive: true });
      // Atomic swap is intentionally non-cancellable once it starts; failure rolls back.
      if (installed) { await rename(target, backup); backedUp = true; }
      await rename(stage, target); swapped = true;
      const result = await this.skills.load(join(target, "content", "SKILL.md"), checked.hash);
      if (!result.manifest.enabled) throw new Error("写入后资源校验失败");
      save(result);
      committed = true;
      return result;
    } catch (error) {
      try {
        if (swapped) await rm(target, { recursive: true, force: true });
        if (backedUp) { await rename(backup, target); backedUp = false; }
      } catch (restoreError) {
        throw new Error(`安装失败且恢复未完成；旧版本备份保留在 ${backup}。${String(restoreError)}`, { cause: error });
      }
      throw error;
    } finally {
      this.installing.delete(target);
      await rm(stage, { recursive: true, force: true });
      if (committed && backedUp) await rm(backup, { recursive: true, force: true }).catch(() => { progress(`安装成功；旧版本备份保留在 ${backup}`); });
    }
  }

  private target(source: GitHubSkillSource, path: string): string {
    const id = createHash("sha256").update(`${source.owner.toLowerCase()}/${source.repo.toLowerCase()}/${path}`).digest("hex").slice(0, 24);
    return join(this.skills.userSkillRoot, `github-${id}`);
  }
  private async readInstallation(path: string): Promise<Installation | undefined> {
    try { return JSON.parse(await readFile(join(path, "installation.json"), "utf8")) as Installation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private resources(tree: TreeEntry[], path: string): TreeEntry[] {
    const entries = tree.filter(entry => (!path || entry.path.startsWith(`${path}/`)) && entry.type !== "tree");
    if (entries.length > 1000 || entries.reduce((n, entry) => n + (entry.size ?? MAX_BYTES + 1), 0) > MAX_BYTES) throw new Error("技能资源超过限制（1000 个文件 / 25 MB）");
    const seen = new Set<string>();
    for (const entry of entries) {
      entry.path.split("/").forEach(safeSegment);
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("技能包含符号链接或子模块，不支持安装");
      const key = entry.path.toLowerCase();
      if (seen.has(key)) throw new Error("资源路径大小写冲突，无法安装");
      seen.add(key);
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  private async download(source: GitHubSkillSource, revision: string, entry: TreeEntry, signal?: AbortSignal): Promise<Buffer> {
    if ((entry.size ?? MAX_BYTES + 1) > MAX_BYTES) throw new Error("技能资源过大");
    let bytes: Buffer;
    try {
      const response = await this.request(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${revision}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, signal);
      bytes = await this.readBytes(response, MAX_BYTES, signal);
    } catch (error) {
      signal?.throwIfAborted();
      try {
        // Blob ids came from the pinned commit's tree, so this fallback cannot change versions.
        const response = await this.request(`https://api.github.com/repos/${source.owner}/${source.repo}/git/blobs/${entry.sha}`, signal);
        const blob = JSON.parse((await this.readBytes(response, Math.ceil(MAX_BYTES * 1.5), signal)).toString("utf8")) as { encoding: string; content: string; sha: string; size: number };
        if (blob.encoding !== "base64" || blob.sha !== entry.sha || blob.size > MAX_BYTES || typeof blob.content !== "string") throw new Error("GitHub 文件响应校验失败");
        bytes = Buffer.from(blob.content, "base64");
        if (bytes.length !== blob.size || bytes.length > MAX_BYTES) throw new Error("GitHub 文件大小校验失败");
      } catch (fallbackError) {
        signal?.throwIfAborted();
        throw new Error(`无法读取 ${entry.path}：${String(fallbackError)}（原始内容通道：${String(error)}）`);
      }
    }
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== entry.sha) throw new Error(`资源校验失败：${entry.path}`);
    return bytes;
  }

  private async readBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("资源下载为空");
    const reader = response.body.getReader();
    try {
      while (true) { signal?.throwIfAborted(); const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > limit) throw new Error("下载资源超过大小限制"); chunks.push(value.value); }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
}
