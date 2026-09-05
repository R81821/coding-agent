import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SkillManifest } from "@harness/protocol";
import { SkillManifestSchema } from "@harness/protocol";
import YAML from "yaml";

/** Skill ids form a directory name under the skill root; reject anything with path semantics. */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SkillDocument {
  manifest: SkillManifest;
  instructions: string;
  hash: string;
  changedSinceTrust: boolean;
}

export interface SkillDraft {
  path: string;
  content: string;
  previousContent?: string;
  manifest: SkillManifest;
}

export class SkillService {
  constructor(private readonly userSkillRoot: string) {}

  async discover(workspacePath?: string): Promise<SkillDocument[]> {
    const files = [
      ...(await findSkillFiles(this.userSkillRoot)),
      ...(workspacePath ? await findSkillFiles(join(workspacePath, ".agent", "skills")) : [])
    ];
    const documents: SkillDocument[] = [];
    for (const path of files) {
      try {
        documents.push(await this.load(path));
      } catch {
        // Invalid skills remain disabled and can be surfaced by the caller's diagnostics.
      }
    }
    return documents;
  }

  async load(path: string, trustedHash?: string): Promise<SkillDocument> {
    const content = await readFile(path, "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    const id = String(frontmatter.id ?? frontmatter.name ?? "").toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const hash = createHash("sha256").update(content).digest("hex");
    const manifest = SkillManifestSchema.parse({
      id,
      name: frontmatter.name,
      version: frontmatter.version,
      description: frontmatter.description ?? "",
      triggers: frontmatter.triggers ?? [],
      tools: frontmatter.tools ?? [],
      pathGlobs: frontmatter.pathGlobs ?? [],
      networkDomains: frontmatter.networkDomains ?? [],
      compatibility: frontmatter.compatibility ?? ">=1.0.0-beta.1",
      sourcePath: path,
      ...(trustedHash ? { trustedHash } : {}),
      enabled: Boolean(trustedHash && trustedHash === hash)
    });
    return { manifest, instructions: body, hash, changedSinceTrust: Boolean(trustedHash && trustedHash !== hash) };
  }

  async draft(manifest: Omit<SkillManifest, "sourcePath" | "trustedHash" | "enabled">, instructions: string, projectRoot?: string): Promise<SkillDraft> {
    if (!SKILL_ID_PATTERN.test(manifest.id)) throw new Error(`Invalid skill id: ${manifest.id}`);
    const root = projectRoot ? join(projectRoot, ".agent", "skills") : this.userSkillRoot;
    const path = resolve(root, manifest.id, "SKILL.md");
    const content = `---\n${YAML.stringify({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      triggers: manifest.triggers,
      tools: manifest.tools,
      pathGlobs: manifest.pathGlobs,
      networkDomains: manifest.networkDomains,
      compatibility: manifest.compatibility
    })}---\n\n${instructions.trim()}\n`;
    let previousContent: string | undefined;
    try { previousContent = await readFile(path, "utf8"); } catch { /* new draft */ }
    return {
      path,
      content,
      ...(previousContent !== undefined ? { previousContent } : {}),
      manifest: { ...manifest, sourcePath: path, enabled: false }
    };
  }

  async approve(draft: SkillDraft): Promise<SkillDocument> {
    if (!SKILL_ID_PATTERN.test(draft.manifest.id)) throw new Error(`Invalid skill id: ${draft.manifest.id}`);
    await mkdir(dirname(draft.path), { recursive: true });
    await writeFile(draft.path, draft.content, { encoding: "utf8", mode: 0o600 });
    const hash = createHash("sha256").update(draft.content).digest("hex");
    return this.load(draft.path, hash);
  }
}

async function findSkillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...await findSkillFiles(path));
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) throw new Error("SKILL.md must begin with YAML frontmatter");
  const parsed = YAML.parse(match[1]) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SKILL.md frontmatter must be an object");
  return { frontmatter: parsed as Record<string, any>, body: match[2] ?? "" };
}

