import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { HarnessDatabase } from "@harness/persistence";
import { McpServerConfigSchema, McpServerInputSchema, type McpServerConfig, type McpServerInput, type McpServerView } from "@harness/protocol";

export function mcpProjectKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function canonicalMcpProject(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("MCP project path must be absolute");
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
    return canonical;
  } catch { throw new Error("MCP project directory is unavailable"); }
}

export function publicMcpServer(config: McpServerConfig): McpServerView {
  const { env, headers, ...publicFields } = config;
  return structuredClone({ ...publicFields, envKeys: Object.keys(env).sort(), headerKeys: Object.keys(headers).sort() });
}

function applySecretPatch(previous: Record<string, string>, patch: Record<string, string | null> = {}, caseInsensitive = false): Record<string, string> {
  const next = { ...previous };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(patch)) {
    const identity = caseInsensitive ? key.toLowerCase() : key;
    if (seen.has(identity)) throw new Error("Duplicate MCP secret names with different casing");
    seen.add(identity);
    if (caseInsensitive) for (const old of Object.keys(next)) if (old.toLowerCase() === identity) delete next[old];
    if (value === null) delete next[key]; else next[key] = value;
  }
  return next;
}

export class McpStore {
  constructor(private readonly database: HarnessDatabase) {}

  list(): McpServerView[] { return this.database.listMcpServers().map(publicMcpServer); }
  get(id: string): McpServerConfig | undefined { return this.database.getMcpServer(id); }

  async save(raw: McpServerInput): Promise<McpServerView> {
    const input = McpServerInputSchema.parse(raw);
    const paths = await Promise.all(input.projectPaths.map(canonicalMcpProject));
    const projectPaths = [...new Map(paths.map(path => [mcpProjectKey(path), path])).values()];
    const transport = input.transport.type === "stdio" && input.transport.cwd !== undefined
      ? { ...input.transport, cwd: await canonicalMcpProject(input.transport.cwd) }
      : input.transport;
    // No await after this read: compare and write are one synchronous SQLite operation sequence.
    const current = input.id ? this.get(input.id) : undefined;
    if (input.id && !current) throw new Error("Unknown MCP server");
    if (current && current.revision !== input.expectedRevision) throw new Error("MCP revision changed; reload the server before editing");
    if (!current && input.expectedRevision !== undefined) throw new Error("New MCP servers must not specify a revision");
    const config = McpServerConfigSchema.parse({
      ...input, transport, projectPaths,
      id: current?.id ?? `mcp_${randomUUID()}`,
      revision: (current?.revision ?? 0) + 1,
      readOnlyTools: [...new Set(input.readOnlyTools)],
      env: applySecretPatch(current?.env ?? {}, input.env, process.platform === "win32"),
      headers: applySecretPatch(current?.headers ?? {}, input.headers, true),
    });
    this.database.saveMcpServer(config);
    return publicMcpServer(config);
  }

  remove(id: string, expectedRevision: number): void {
    const current = this.get(id);
    if (!current) throw new Error("Unknown MCP server");
    if (current.revision !== expectedRevision) throw new Error("MCP revision changed; reload the server before deleting");
    this.database.deleteMcpServer(id);
  }
}
