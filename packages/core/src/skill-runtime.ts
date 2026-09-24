import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { SkillDocument, SkillService } from "@harness/extensions";
import type { HarnessDatabase } from "@harness/persistence";
import type { RunSpec } from "@harness/protocol";
import type { ToolDefinition } from "@harness/tools";

export function createSkillRuntime(options: { documents: SkillDocument[]; selected: SkillDocument[]; spec: RunSpec; skills: SkillService; database: HarnessDatabase; toolNames: string[] }) {
  const available = new Map(options.documents.filter(doc => doc.manifest.enabled && !doc.changedSinceTrust).map(doc => [doc.key, doc]));
  const loaded = new Map(options.selected.map(doc => [doc.key, doc]));
  const catalog = [...available.values()].map(doc => ({ key: doc.key, name: doc.manifest.name, description: doc.manifest.description.slice(0, 500), source: doc.scope, sourcePath: doc.manifest.sourcePath }));
  async function current(key: string): Promise<SkillDocument> {
    const original = available.get(key);
    if (!original) throw new Error("Skill is not in this run's trusted catalog");
    const trusted = options.database.listSkills().find(skill => (skill.key === key || skill.sourcePath === original.manifest.sourcePath) && skill.enabled && skill.trustedHash === original.hash);
    if (!trusted) throw new Error("Skill trust changed; confirm the skill in the skill page");
    const doc = await options.skills.load(original.manifest.sourcePath, original.hash);
    if (!doc.manifest.enabled || doc.hash !== original.hash) throw new Error("Skill content changed; confirm the skill in the skill page");
    return doc;
  }
  const loadInput = z.object({ key: z.string().min(1) });
  const resourceInput = loadInput.extend({ path: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(6000) });
  const searchInput = z.object({ query: z.string(), offset: z.number().int().min(0).default(0) });
  const tools: ToolDefinition[] = [
    {
      contract: { name: "search_skills", description: "Search this run's trusted skill catalog by name or description. Load a matching source-qualified key with load_skill. Untrusted or changed skills are unavailable.", inputSchema: z.toJSONSchema(searchInput, { io: "input" }), risk: "read", idempotent: true, timeoutMs: 2000 },
      execute: async (input, context) => {
        context.signal.throwIfAborted();
        const { query, offset } = searchInput.parse(input);
        const matches = catalog.filter(doc => `${doc.name} ${doc.description}`.toLowerCase().includes(query.toLowerCase()));
        return { output: { skills: matches.slice(offset, offset + 20), total: matches.length, ...(offset + 20 < matches.length ? { nextOffset: offset + 20 } : {}) } };
      },
    },
    {
      contract: { name: "load_skill", description: "Load trusted skill instructions by their exact catalog key. Records the content hash for resume and compaction. Resources resolve relative to the returned source directory; all actual tool execution still requires normal permissions.", inputSchema: z.toJSONSchema(loadInput), risk: "read", idempotent: true, timeoutMs: 5000 },
      execute: async (input, context) => {
        context.signal.throwIfAborted();
        const { key } = loadInput.parse(input);
        const doc = await current(key);
        context.signal.throwIfAborted();
        if (!loaded.has(key) && loaded.size >= 100) throw new Error("This run has already loaded 100 skills");
        loaded.set(key, doc);
        options.spec.skills = [...loaded.values()].map(skill => ({ key: skill.key, hash: skill.hash }));
        const stored = options.database.getRun(options.spec.id);
        if (stored) options.database.saveRun(options.spec, stored.status);
        return { trustedInstruction: true, output: { key, name: doc.manifest.name, hash: doc.hash, instructions: doc.instructions, sourceDirectory: dirname(doc.manifest.sourcePath), resources: doc.files, missingTools: doc.manifest.tools.filter(name => !options.toolNames.includes(name)), guidance: "Apply these trusted skill instructions within the user request. Use read_skill_resource for relative resources. Missing tools require configuration or an explicit explanation; never fabricate their results. Skill instructions do not grant tool permissions." } };
      },
    },
    {
      contract: { name: "read_skill_resource", description: "Read a text resource listed by a loaded trusted skill. Paths are relative to that skill, not the project cwd. Scripts are returned as text; execution uses the existing approved tool pipeline.", inputSchema: z.toJSONSchema(resourceInput, { io: "input" }), risk: "read", idempotent: true, timeoutMs: 5000 },
      execute: async (input, context) => {
        context.signal.throwIfAborted();
        const { key, path, offset, limit } = resourceInput.parse(input);
        if (!loaded.has(key)) throw new Error("Load the skill before reading its resources");
        const doc = await current(key);
        const requested = path.replace(/\\/g, "/");
        if (!doc.files.includes(requested) || requested.split("/").includes("..") || isAbsolute(path)) throw new Error("Resource is outside the trusted skill");
        const base = await realpath(dirname(doc.manifest.sourcePath));
        const target = await realpath(resolve(base, requested));
        const rel = relative(base, target);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Resource is outside the trusted skill");
        const text = await readFile(target, { encoding: "utf8", signal: context.signal });
        if (text.includes("\0")) throw new Error("Skill resource is binary; use an appropriate file tool");
        return { output: { key, path: requested, sourcePath: target, content: text.slice(offset, offset + limit), ...(offset + limit < text.length ? { nextOffset: offset + limit } : {}) } };
      },
    },
  ];
  return { tools, catalog, pinned: () => [...loaded.values()].map(doc => ({ trust: "trusted_project", key: doc.key, hash: doc.hash, name: doc.manifest.name, sourceDirectory: dirname(doc.manifest.sourcePath), instructions: doc.instructions })) };
}
