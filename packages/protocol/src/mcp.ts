import { z } from "zod";

const processText = z.string().max(16_384).refine(value => !value.includes("\0"), "NUL is not allowed");
const serverId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const remoteUrl = z.string().max(4096).url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, "MCP URL must use HTTP(S) without embedded credentials or a fragment");
export const McpTransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), command: processText.refine(value => value.trim().length > 0, "Command is required"), args: z.array(processText).max(256).default([]), cwd: processText.optional() }),
  z.object({ type: z.literal("streamable_http"), url: remoteUrl }),
  z.object({ type: z.literal("sse"), url: remoteUrl }),
]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256);
const reservedHeaders = new Set(["host", "content-length", "connection", "transfer-encoding", "accept", "content-type"]);
const headerKey = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).max(256)
  .refine(value => !reservedHeaders.has(value.toLowerCase()) && !value.toLowerCase().startsWith("mcp-"), "Transport headers are managed by the MCP client");
const headerValue = z.string().max(16_384).regex(/^[\x20-\x7e]*$/, "Header values must be printable ASCII");
const common = {
  name: z.string().trim().min(1).max(160),
  transport: McpTransportSchema,
  enabled: z.boolean().default(false),
  projectPaths: z.array(processText.refine(value => value.length > 0)).max(128).default([]),
  readOnlyTools: z.array(z.string().min(1).max(256)).max(2048).default([]),
  connectTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  callTimeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
};

/** Secret patch semantics: omitted = keep, null = remove, string (including empty) = replace. */
export const McpServerInputSchema = z.object({
  ...common,
  id: serverId.optional(),
  expectedRevision: z.number().int().positive().optional(),
  env: z.record(envKey, processText.nullable()).optional(),
  headers: z.record(headerKey, headerValue.nullable()).optional(),
});
export type McpServerInput = z.input<typeof McpServerInputSchema>;
export const McpServerConfigSchema = z.object({
  ...common,
  id: serverId,
  revision: z.number().int().positive(),
  env: z.record(envKey, processText).default({}),
  headers: z.record(headerKey, headerValue).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export interface McpServerView extends Omit<McpServerConfig, "env" | "headers"> {
  envKeys: string[];
  headerKeys: string[];
}
export type McpConnectionState = "disabled" | "disconnected" | "connecting" | "connected" | "auth_required" | "error";
export interface McpConnectionStatus {
  serverId: string;
  revision: number;
  workspacePath: string;
  state: McpConnectionState;
  toolCount: number;
  error?: string;
}
export interface McpAuthStatus { state: "signed_out" | "pending" | "authorized" | "error"; error?: string }
export interface McpManagementSnapshot {
  servers: McpServerView[];
  statuses: McpConnectionStatus[];
  auth: Record<string, McpAuthStatus>;
}
const projectRequest = z.object({ serverId, workspacePath: z.string().min(1) });
export const McpRequestSchemas = [
  z.object({ id: z.string(), method: z.literal("mcp.list"), params: z.object({ workspacePath: z.string().min(1).optional() }).default({}) }),
  z.object({ id: z.string(), method: z.literal("mcp.save"), params: McpServerInputSchema }),
  z.object({ id: z.string(), method: z.literal("mcp.remove"), params: z.object({ serverId, expectedRevision: z.number().int().positive() }) }),
  z.object({ id: z.string(), method: z.literal("mcp.connect"), params: projectRequest }),
  z.object({ id: z.string(), method: z.literal("mcp.disconnect"), params: projectRequest }),
  z.object({ id: z.string(), method: z.literal("mcp.tools"), params: projectRequest }),
  z.object({ id: z.string(), method: z.literal("mcp.import"), params: z.object({ source: z.string().min(1).max(1_000_000), workspacePath: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("mcp.auth.start"), params: z.object({ serverId }) }),
  z.object({ id: z.string(), method: z.literal("mcp.auth.logout"), params: z.object({ serverId }) }),
] as const;
export const McpRequestSchema = z.discriminatedUnion("method", McpRequestSchemas);
export type McpRequest = z.infer<typeof McpRequestSchema>;
export const McpToolSnapshotSchema = z.object({
  serverId, revision: z.number().int().positive(), toolName: z.string(), name: z.string(),
  contractHash: z.string(), risk: z.enum(["read", "high"]),
  // Older checkpoints have only contractHash. They must not infer schema equivalence.
  semanticContractHash: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type McpToolSnapshot = z.infer<typeof McpToolSnapshotSchema>;
