import { McpServerInputSchema, type McpServerInput, type McpServerView, type McpTransport } from "@harness/protocol";

export interface SecretEdit { key: string; mode: "keep" | "replace" | "clear"; value: string; persisted?: boolean }
export interface McpForm {
  id: string | undefined;
  expectedRevision: number | undefined;
  name: string;
  type: McpTransport["type"];
  command: string;
  args: string;
  cwd: string;
  url: string;
  enabled: boolean;
  projects: string;
  readOnlyTools: string;
  connectSeconds: number;
  callSeconds: number;
  env: SecretEdit[];
  headers: SecretEdit[];
}
export function mcpForm(server: McpServerView | McpServerInput | undefined, workspace: string): McpForm {
  const transport = server?.transport;
  const secrets = (kind: "env" | "headers", keys: "envKeys" | "headerKeys"): SecretEdit[] => {
    if (server && keys in server) return (server as McpServerView)[keys].map(key => ({ key, mode: "keep", value: "", persisted: true }));
    return Object.entries((server as McpServerInput | undefined)?.[kind] ?? {}).map(([key, value]) => ({ key, mode: value === null ? "clear" : "replace", value: value ?? "" }));
  };
  return {
    id: server?.id, expectedRevision: server && "revision" in server ? server.revision : undefined,
    name: server?.name ?? "", type: transport?.type ?? "stdio", command: transport?.type === "stdio" ? transport.command : "",
    args: JSON.stringify(transport?.type === "stdio" ? transport.args ?? [] : [], null, 2), cwd: transport?.type === "stdio" ? transport.cwd ?? "" : "",
    url: transport && transport.type !== "stdio" ? transport.url : "", enabled: server?.enabled ?? false,
    projects: (server?.projectPaths ?? (workspace ? [workspace] : [])).join("\n"), readOnlyTools: (server?.readOnlyTools ?? []).join("\n"),
    connectSeconds: (server?.connectTimeoutMs ?? 15_000) / 1000, callSeconds: (server?.callTimeoutMs ?? 60_000) / 1000,
    env: secrets("env", "envKeys"), headers: secrets("headers", "headerKeys"),
  };
}
export function secretPatch(rows: SecretEdit[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.key.trim();
    if (!name) throw new Error("密钥名称不能为空");
    if (names.has(name)) throw new Error("密钥名称重复");
    names.add(name);
    if (row.mode !== "keep") result[name] = row.mode === "clear" ? null : row.value;
  }
  return result;
}
export function buildMcpDraft(form: McpForm) {
  let args: unknown;
  try { args = JSON.parse(form.args); } catch { throw new Error('参数需为 JSON 字符串数组，例如 ["server.mjs", "--port", "3000"]'); }
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsed = McpServerInputSchema.safeParse({
    ...(form.id ? { id: form.id, expectedRevision: form.expectedRevision } : {}),
    name: form.name, enabled: form.enabled, projectPaths: lines(form.projects), readOnlyTools: lines(form.readOnlyTools),
    transport: form.type === "stdio" ? { type: "stdio", command: form.command, args, ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}) } : { type: form.type, url: form.url },
    connectTimeoutMs: form.connectSeconds * 1000, callTimeoutMs: form.callSeconds * 1000,
    env: secretPatch(form.env), headers: secretPatch(form.headers),
  });
  if (!parsed.success) throw new Error(`配置无效：${parsed.error.issues.map(issue => issue.path.join(".")).join("、")}`);
  return parsed.data;
}
