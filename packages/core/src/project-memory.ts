import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MemoryPublicationPreview, MemoryRecord } from "@harness/protocol";
import type { MemoryService } from "@harness/extensions";
import { knowledgeFingerprint, type ProjectTrustService } from "./project-trust.js";

const START = "<!-- harness-memory:start -->";
const END = "<!-- harness-memory:end -->";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const plain = (text: string) => text.replace(/\r?\n/g, " ").replace(/<!--/g, "&lt;!--");
function section(before: string, body: string): string {
  const start = before.indexOf(START), end = before.indexOf(END);
  if ((start < 0) !== (end < 0) || start >= 0 && (end < start || before.indexOf(START, start + START.length) >= 0 || before.indexOf(END, end + END.length) >= 0)) {
    throw new Error("项目知识区标记不完整，请先修复文件再同步");
  }
  const block = `${START}\n${body}\n${END}`;
  return start < 0 ? `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n${block}\n`
    : before.slice(0, start) + block + before.slice(end + END.length);
}
async function safePath(root: string, path: string): Promise<string> {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("项目知识路径不能是符号链接或目录联接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export class ProjectMemoryService {
  private readonly writes = new Set<string>();
  constructor(private readonly memory: MemoryService, private readonly trust: ProjectTrustService) {}

  async preview(workspacePath: string, memoryIds: string[]): Promise<MemoryPublicationPreview> {
    const root = await realpath(workspacePath);
    const all = this.memory.list();
    const selected = [...new Set(memoryIds)].map(id => {
      const item = all.find(memory => memory.id === id);
      if (!item || item.scope !== "project" || resolve(item.scopeId) !== resolve(workspacePath) || item.status !== "approved" ||
        !["convention", "decision", "fact"].includes(item.kind ?? "") || item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) {
        throw new Error("仅能同步当前项目已批准、有效的规范、决策和事实");
      }
      return item;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const render = (items: MemoryRecord[]) => items.map(item => `- ${plain(item.content)}\n  - 来源：${plain((item.sources ?? [item.source]).join("、"))}；记录：${item.id}`).join("\n");
    const conventions = selected.filter(item => item.kind === "convention");
    const knowledge = selected.filter(item => item.kind !== "convention");
    const files: MemoryPublicationPreview["files"] = [];
    const originalStates: Array<string | undefined> = [];
    for (const [path, body] of [
      ["AGENTS.md", `## 已确认的项目规范\n\n${render(conventions) || "暂无已确认规范。"}\n\n## 项目知识索引\n\n涉及已有设计、接口或问题经验时，按任务需要读取 docs/agent-knowledge.md；核对记录来源及代码现状。\n任务完成后整理有依据的长期偏好、项目规范和决策，合并重复项，通过记忆管理更新；一次性要求保留在任务记录中。`],
      ["docs/agent-knowledge.md", `# 已确认的项目知识\n\n以下记录用于理解项目背景，使用前核对当前实现。\n\n${render(knowledge) || "暂无已确认决策和事实。"}`],
    ] as const) {
      const original = await readOptional(await safePath(root, path));
      const before = original ?? "";
      const after = section(before, body);
      if (Buffer.byteLength(after) > (path === "AGENTS.md" ? 32_768 : 262_144)) throw new Error(`${path} 内容过长，请精简后同步`);
      files.push({ path, before, after }); originalStates.push(original);
    }
    return { workspacePath: root, files, memoryIds: selected.map(item => item.id),
      token: digest(JSON.stringify({ root, files, originalStates, selected })) };
  }

  async publish(workspacePath: string, memoryIds: string[], token: string): Promise<{ paths: string[] }> {
    const root = await realpath(workspacePath);
    if (this.writes.has(root)) throw new Error("项目知识正在同步，请稍后重试");
    this.writes.add(root);
    const written: Array<{ path: string; before: string | undefined; after: string }> = [];
    try {
      const accepted = this.memory.list().filter(item => memoryIds.includes(item.id)).map(item => ({ id: item.id, hash: knowledgeFingerprint(item) }));
      const verifyMemories = () => {
        const current = this.memory.list();
        if (accepted.length !== new Set(memoryIds).size || accepted.some(ref => {
          const item = current.find(item => item.id === ref.id);
          return !item || item.status !== "approved" || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) || knowledgeFingerprint(item) !== ref.hash;
        })) throw new Error("记忆已变化，请重新预览后同步");
      };
      const preview = await this.preview(workspacePath, memoryIds);
      verifyMemories();
      if (preview.token !== token) throw new Error("记忆或项目文件已变化，请重新预览后同步");
      for (const file of preview.files) {
        const path = await safePath(root, file.path);
        const before = await readOptional(path);
        if ((before ?? "") !== file.before) throw new Error("项目文件已变化，请重新预览");
        if (before === file.after) continue;
        await mkdir(dirname(path), { recursive: true });
        await safePath(root, file.path);
        written.push({ path, before, after: file.after });
        await writeFile(path, file.after, "utf8");
      }
      // The UI's publish action explicitly accepts the exact AGENTS content in this preview.
      const instructions = preview.files.find(file => file.path === "AGENTS.md")!;
      if (await readOptional(join(root, "AGENTS.md")) !== instructions.after) throw new Error("项目规范已被其他操作修改，请重新预览");
      verifyMemories();
      this.trust.trust(root, [{ path: "AGENTS.md", sha256: digest(instructions.after) }], accepted);
      return { paths: preview.files.map(file => join(root, file.path)) };
    } catch (error) {
      for (const file of written.reverse()) {
        if (await readOptional(file.path) !== file.after) continue;
        if (file.before === undefined) await unlink(file.path);
        else await writeFile(file.path, file.before, "utf8");
      }
      throw error;
    } finally { this.writes.delete(root); }
  }
}
