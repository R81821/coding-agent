import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { AGENTS_MD_TEMPLATE } from "./context.js";

export interface ProjectTrustFile {
  path: string;
  sha256: string;
  content: string;
}

export interface ProjectTrustRecord {
  workspacePath: string;
  files: Array<{ path: string; sha256: string }>;
  trustedAt: string;
}

export interface ProjectTrustRepository {
  saveProjectTrust(workspacePath: string, value: unknown): void;
  getProjectTrust<T>(workspacePath: string): T | undefined;
}

export class ProjectTrustService {
  constructor(private readonly repository: ProjectTrustRepository) {}

  async inspect(workspacePath: string): Promise<{ files: ProjectTrustFile[]; trusted: boolean; changed: boolean }> {
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
    return { files, trusted, changed };
  }

  trust(workspacePath: string, files: Array<{ path: string; sha256: string }>): ProjectTrustRecord {
    const root = resolve(workspacePath);
    for (const file of files) {
      const candidate = resolve(root, file.path);
      const rel = relative(root, candidate);
      if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`Trusted instruction path escapes workspace: ${file.path}`);
    }
    const record = { workspacePath: root, files, trustedAt: new Date().toISOString() };
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

  async loadInstructions(workspacePath: string): Promise<string | undefined> {
    const root = resolve(workspacePath);
    const record = this.repository.getProjectTrust<ProjectTrustRecord>(root);
    if (!record) return undefined;
    const contents: string[] = [];
    for (const file of record.files) {
      const candidate = resolve(root, file.path);
      const content = await readFile(candidate, "utf8");
      if (createHash("sha256").update(content).digest("hex") !== file.sha256) return undefined;
      contents.push(`# ${file.path}\n${content}`);
    }
    return contents.length ? contents.join("\n\n") : undefined;
  }
}
