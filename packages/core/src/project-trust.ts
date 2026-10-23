import { createHash } from "node:crypto";
import { open, lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { AGENTS_MD_TEMPLATE, LEGACY_AGENTS_MD_TEMPLATE } from "./context.js";
import type { MemoryRecord } from "@harness/protocol";

export function knowledgeFingerprint(memory: MemoryRecord): string {
  return createHash("sha256").update(JSON.stringify([memory.content, memory.scope, memory.scopeId, memory.kind, memory.key, memory.expiresAt])).digest("hex");
}

/** Exact generated template only; a managed memory suffix is preserved byte-for-byte. */
export function projectInstructionMigration(content: string): string | undefined {
  const normalized = content.replaceAll("\r\n", "\n");
  const legacy = LEGACY_AGENTS_MD_TEMPLATE.replaceAll("\r\n", "\n");
  if (normalized === legacy) return AGENTS_MD_TEMPLATE;
  if (normalized.startsWith(legacy)) {
    const suffix = normalized.slice(legacy.length);
    if (/^\s*<!-- harness-memory:start -->[\s\S]*<!-- harness-memory:end -->\s*$/.test(suffix)) {
      const originalSuffix = content.slice(content.indexOf("<!-- harness-memory:start -->"));
      return AGENTS_MD_TEMPLATE + "\n" + originalSuffix;
    }
  }
  return undefined;
}

export interface ProjectTrustFile {
  path: string;
  sha256: string;
  content: string;
}

export interface ProjectTrustRecord {
  workspacePath: string;
  files: Array<{ path: string; sha256: string }>;
  trustedAt: string;
  memoryRefs?: Array<{ id: string; hash: string }>;
  /** Proposed hashes are not trusted; retain provenance only for an exact reviewed migration. */
  pendingMigration?: { files: Array<{ path: string; sha256: string }>; memoryRefs: Array<{ id: string; hash: string }> };
}

export interface ProjectTrustRepository {
  saveProjectTrust(workspacePath: string, value: unknown): void;
  getProjectTrust<T>(workspacePath: string): T | undefined;
  listMemories?(): MemoryRecord[];
}

export class ProjectTrustService {
  constructor(private readonly repository: ProjectTrustRepository) {}

  async inspect(workspacePath: string): Promise<{ files: ProjectTrustFile[]; trusted: boolean; changed: boolean; migration?: { fromSha256: string; content: string } }> {
    const root = resolve(workspacePath);
    const files: ProjectTrustFile[] = [];
    for (const candidate of [resolve(root, "AGENTS.md")]) {
      try {
        const content = await readFile(candidate, "utf8");
        files.push({ path: relative(root, candidate), sha256: createHash("sha256").update(content).digest("hex"), content });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const previous = this.repository.getProjectTrust<ProjectTrustRecord>(root);
    const trusted = Boolean(previous);
    const changed = trusted && JSON.stringify(previous?.files ?? []) !== JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })));
    const agents = files.find(file => file.path === "AGENTS.md");
    const migrated = agents && projectInstructionMigration(agents.content);
    return { files, trusted, changed, ...(agents && migrated ? { migration: { fromSha256: agents.sha256, content: migrated } } : {}) };
  }

  trust(workspacePath: string, files: Array<{ path: string; sha256: string }>, memoryRefs?: ProjectTrustRecord["memoryRefs"]): ProjectTrustRecord {
    const root = resolve(workspacePath);
    for (const file of files) {
      const candidate = resolve(root, file.path);
      const rel = relative(root, candidate);
      if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`Trusted instruction path escapes workspace: ${file.path}`);
    }
    const previous = this.repository.getProjectTrust<ProjectTrustRecord>(root);
    const refs = memoryRefs ?? (JSON.stringify(previous?.files) === JSON.stringify(files) ? previous?.memoryRefs :
      JSON.stringify(previous?.pendingMigration?.files) === JSON.stringify(files) ? previous?.pendingMigration?.memoryRefs : undefined);
    const record = { workspacePath: root, files, trustedAt: new Date().toISOString(), ...(refs ? { memoryRefs: refs } : {}) };
    this.repository.saveProjectTrust(root, record);
    return record;
  }

  /**
   * Write the built-in project conventions as `AGENTS.md`, and nothing else: trusting stays a
   * separate, explicit step so the user still reads the content before it gains instruction status.
   *
   * The path is fixed, so no caller-supplied name can escape the workspace, and the file is created
   * with `wx` — a project that already has its own AGENTS.md is never overwritten.
   */
  async scaffold(workspacePath: string): Promise<{ path: string; sha256: string }> {
    const root = resolve(workspacePath);
    const candidate = resolve(root, "AGENTS.md");
    try {
      await writeFile(candidate, AGENTS_MD_TEMPLATE, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("该仓库已有 AGENTS.md，未做任何改动。");
      throw new Error(`无法写入 ${candidate}：${error instanceof Error ? error.message : String(error)}`);
    }
    return { path: relative(root, candidate), sha256: createHash("sha256").update(AGENTS_MD_TEMPLATE).digest("hex") };
  }

  /** Apply the reviewed exact-template migration; the new hash must still be explicitly trusted. */
  async migrate(workspacePath: string, expectedSha256: string): Promise<{ path: string; sha256: string }> {
    const candidate = resolve(workspacePath, "AGENTS.md");
    if ((await lstat(candidate)).isSymbolicLink() || await realpath(candidate) !== candidate) throw new Error("不能迁移链接指向的项目规范。");
    const handle = await open(candidate, "r+");
    try {
      const content = await handle.readFile("utf8");
      if (createHash("sha256").update(content).digest("hex") !== expectedSha256) throw new Error("项目规范已变化，请重新预览。");
      const replacement = projectInstructionMigration(content);
      if (!replacement) throw new Error("包含自定义规则，不能自动替换；请手动审阅。");
      const bytes = Buffer.from(replacement, "utf8");
      await handle.write(bytes, 0, bytes.length, 0);
      await handle.truncate(bytes.length);
      await handle.sync();
      const migrated = { path: "AGENTS.md", sha256: createHash("sha256").update(bytes).digest("hex") };
      const root = resolve(workspacePath);
      const previous = this.repository.getProjectTrust<ProjectTrustRecord>(root);
      if (previous?.memoryRefs && previous.files.length === 1 && previous.files[0]?.path === "AGENTS.md" && previous.files[0].sha256 === expectedSha256) {
        this.repository.saveProjectTrust(root, { ...previous, pendingMigration: { files: [migrated], memoryRefs: previous.memoryRefs } });
      }
      return migrated;
    } finally { await handle.close(); }
  }

  async loadInstructions(workspacePath: string): Promise<string | undefined> {
    const root = resolve(workspacePath);
    const record = this.repository.getProjectTrust<ProjectTrustRecord>(root);
    if (!record) return undefined;
    const memories = this.repository.listMemories?.() ?? [];
    const staleKnowledge = record.memoryRefs?.some(ref => {
      const memory = memories.find(item => item.id === ref.id);
      return !memory || memory.status !== "approved" || memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now() || knowledgeFingerprint(memory) !== ref.hash;
    });
    const contents: string[] = [];
    for (const file of record.files) {
      const candidate = resolve(root, file.path);
      const content = await readFile(candidate, "utf8");
      if (createHash("sha256").update(content).digest("hex") !== file.sha256) return undefined;
      const active = staleKnowledge ? content.replace(/<!-- harness-memory:start -->[\s\S]*?<!-- harness-memory:end -->/, "已同步的项目知识发生变化，本轮使用当前有效的项目记忆；请在记忆页重新同步项目规范。") : content;
      contents.push(`# ${file.path}\n${active}`);
    }
    return contents.length ? contents.join("\n\n") : undefined;
  }
}
