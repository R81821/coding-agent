import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import fg from "fast-glob";
import { confinedPath } from "./paths.js";
import type { ToolDefinition, ToolRegistry } from "./types.js";
import { runProcess } from "./process.js";

const readInput = z.object({ path: z.string(), offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(2000).default(200) });
export const pagedReadTool: ToolDefinition = {
  contract: { name: "read_file", description: "Read numbered UTF-8 lines. offset is one-based, default 1; limit defaults to 200, maximum 2000. Output capped at 64 KiB. Continue using nextOffset.", inputSchema: z.toJSONSchema(readInput, { io: "input" }), risk: "read", idempotent: true, timeoutMs: 10000 },
  async execute(input, context) {
    const { path, offset, limit } = readInput.parse(input);
    const stream = createReadStream(await confinedPath(context.workspacePath, path), { encoding: "utf8", signal: context.signal });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    const selected: string[] = []; let lineNumber = 0, bytes = 0, truncated = false;
    try {
      for await (const line of reader) {
        if (++lineNumber < offset) continue;
        const numbered = `${lineNumber}: ${line}`;
        const size = Buffer.byteLength(numbered + "\n");
        if (selected.length >= limit || bytes + size > 64000) { truncated = true; break; }
        selected.push(numbered); bytes += size;
      }
    } finally { reader.close(); stream.destroy(); }
    return { output: { path, offset, content: selected.join("\n"), truncated, ...(truncated ? { nextOffset: offset + selected.length, ...(selected.length === 0 ? { code: "line_exceeds_budget", guidance: "Use search_files for a matching excerpt; this line exceeds the output budget." } : {}) } : {}) }, truncated };
  },
};
const searchInput = z.object({ query: z.string().optional(), glob: z.string().default("**/*"), mode: z.enum(["name", "content"]).default("content"), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) });
export const searchFilesTool: ToolDefinition = {
  contract: { name: "search_files", description: "Search file names or content inside the workspace, with zero-based result offset and limit. Use mode=name for glob paths; mode=content requires query.", inputSchema: z.toJSONSchema(searchInput, { io: "input" }), risk: "read", idempotent: true, timeoutMs: 20000 },
  async execute(input, context) {
    const value = searchInput.parse(input);
    if (value.glob.includes("..")) throw new Error("Parent traversal is not allowed");
    let results: string[], incomplete = false;
    if (value.mode === "name") results = (await fg(value.glob, { cwd: context.workspacePath, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: [".git/**", "node_modules/**"] })).sort().filter(path => !value.query || path.includes(value.query));
    else {
      if (!value.query) throw new Error("query is required for content search");
      const result = await runProcess("rg", ["--line-number", "--no-heading", "--color", "never", "-g", value.glob, "--", value.query, "."], { cwd: context.workspacePath, signal: context.signal, timeoutMs: 20000, maxOutputBytes: 4_000_000 });
      if (result.exitCode !== 0 && result.exitCode !== 1) return { isError: true, output: { code: "search_failed", error: result.stderr.slice(0, 2000) } };
      results = result.stdout.split(/\r?\n/).filter(Boolean); incomplete = result.truncated;
    }
    const page = results.slice(value.offset, value.offset + value.limit);
    let bytes = 0;
    const matches = page.filter(line => { bytes += Buffer.byteLength(line + "\n"); return bytes < 60000; });
    const nextOffset = value.offset + matches.length;
    const truncated = incomplete || nextOffset < results.length;
    return { output: { matches, offset: value.offset, ...(truncated ? { nextOffset } : {}), truncated }, truncated };
  },
};
export function lightweightTools(registry: ToolRegistry, allowed: string[]): ToolDefinition[] {
  const tools = registry.contracts(allowed).flatMap(contract => {
    if (["update_workflow", "list_files", "search_text", "read_range"].includes(contract.name)) return [];
    const tool = registry.get(contract.name)!;
    if (contract.name === "read_file") return [pagedReadTool];
    if (contract.name === "apply_patch") return [{ ...tool, contract: { ...tool.contract, name: "patch" } }];
    return [tool];
  });
  if (allowed.some(name => ["search_text", "list_files", "search_files"].includes(name))) tools.push(searchFilesTool);
  return tools;
}
