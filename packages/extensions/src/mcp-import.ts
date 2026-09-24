import { z } from "zod";
import { McpServerInputSchema } from "@harness/protocol";

const importSchema = z.object({ mcpServers: z.record(z.string().min(1).max(160), z.object({
  type: z.enum(["stdio", "http", "streamable_http", "streamable-http", "sse"]).optional(),
  command: z.string().optional(), args: z.array(z.string()).optional(), cwd: z.string().optional(), url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), disabled: z.boolean().optional(),
}).strict()) }).strict();
export function previewMcpImport(source: string, workspacePath: string) {
  try {
    const imported = importSchema.parse(JSON.parse(source));
    const entries = Object.entries(imported.mcpServers);
    if (entries.length > 128) throw new Error("Too many servers");
    const servers = entries.map(([name, entry]) => {
      if ((!!entry.command === !!entry.url) || (entry.type === "stdio" && !entry.command) || (entry.type && entry.type !== "stdio" && !entry.url)) throw new Error("Ambiguous transport");
      return McpServerInputSchema.parse({ name, enabled: false, projectPaths: [workspacePath],
        transport: entry.command ? { type: "stdio", command: entry.command, args: entry.args ?? [], ...(entry.cwd ? { cwd: entry.cwd } : {}) } : { type: entry.type === "sse" ? "sse" : "streamable_http", url: entry.url },
        ...(entry.env ? { env: entry.env } : {}), ...(entry.headers ? { headers: entry.headers } : {}),
      });
    });
    return { servers };
  } catch { throw new Error("Invalid MCP import: expected mcpServers with a command or HTTP(S) URL per server"); }
}
