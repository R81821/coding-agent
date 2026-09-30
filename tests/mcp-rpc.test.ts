import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DaemonRequestSchema } from "@harness/protocol";
import { McpStore, McpService } from "@harness/extensions";
import { McpOAuthManager } from "../packages/extensions/src/mcp-oauth.js";
import { dispatchMcp, isMcpRequest } from "../apps/daemon/src/mcp-rpc.js";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-mcp-rpc-"));
  const crypto = await VaultCrypto.open(join(root, "key.json"), "mcp-rpc-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), crypto);
  const store = new McpStore(database), mcp = new McpService(store), mcpAuth = new McpOAuthManager(database, store);
  cleanup.push(async () => { await mcp.close(); await mcpAuth.close(); database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  const rpc = async (method: string, params?: unknown) => {
    const sanitized = sanitizeRendererRequest(method, params);
    const request = DaemonRequestSchema.parse({ id: "test", ...sanitized });
    if (!isMcpRequest(request)) throw new Error("Expected MCP request");
    return dispatchMcp(request, { mcp, mcpAuth });
  };
  return { root, mcp, rpc };
}
test("management RPC saves, lists and deletes without exposing stored secrets", async () => {
  const f = await fixture();
  const saved = await f.rpc("mcp.save", { name: "Secret", enabled: false, projectPaths: [f.root], transport: { type: "streamable_http", url: "https://mcp.example.test/mcp" }, headers: { Authorization: "Bearer rpc-fixture-secret" } }) as { id: string; revision: number };
  const snapshot = await f.rpc("mcp.list", { workspacePath: f.root });
  expect(JSON.stringify(snapshot)).not.toContain("rpc-fixture-secret");
  expect(snapshot).toMatchObject({ servers: [{ id: saved.id, headerKeys: ["Authorization"] }], statuses: [{ state: "disabled" }] });
  await expect(f.rpc("mcp.remove", { serverId: saved.id, expectedRevision: 9 })).rejects.toThrow(/revision/);
  await f.rpc("mcp.remove", { serverId: saved.id, expectedRevision: saved.revision });
  expect(f.mcp.store.list()).toEqual([]);
});
test("JSON import previews disabled configurations without persisting or executing commands", async () => {
  const f = await fixture();
  const marker = join(f.root, "should-not-exist.txt");
  const preview = await f.rpc("mcp.import", { source: JSON.stringify({ mcpServers: { local: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], env: { TOKEN: "import-secret" } }, remote: { type: "http", url: "https://mcp.example.test/mcp" } } }), workspacePath: f.root });
  expect(preview).toMatchObject({ servers: [{ name: "local", enabled: false, transport: { type: "stdio" } }, { name: "remote", enabled: false, transport: { type: "streamable_http" } }] });
  expect(f.mcp.store.list()).toEqual([]);
  await expect(readFile(marker)).rejects.toThrow();
  await expect(f.rpc("mcp.import", { source: '{"mcpServers":{"bad":{"url":"file:///etc/passwd"}}}', workspacePath: f.root })).rejects.toThrow(/import/i);
});
test("MCP renderer methods remain schema-validated and never expose direct tool execution", async () => {
  const f = await fixture();
  await expect(f.rpc("mcp.callTool", { name: "write" })).rejects.toThrow(/cannot invoke/);
  await expect(f.rpc("mcp.connect", { serverId: "x" })).rejects.toThrow();
  await expect(f.rpc("mcp.save", { name: "invalid", transport: { type: "stdio", command: "node" }, headers: { Authorization: "secret\r\nInjected: bad" } })).rejects.toThrow();
});

test("OAuth action connects a public MCP server without starting browser authorization", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url)), "public"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); } });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public MCP fixture did not start")), 5000);
    child.stdout.once("data", data => { clearTimeout(timer); resolve(JSON.parse(data.toString()).url); });
  });
  const saved = await f.rpc("mcp.save", { name: "Public", enabled: true, projectPaths: [f.root], transport: { type: "streamable_http", url } }) as { id: string };
  expect(await f.rpc("mcp.auth.start", { serverId: saved.id })).toMatchObject({ state: "not_required" });
  expect(await f.rpc("mcp.list", { workspacePath: f.root })).toMatchObject({ statuses: [{ serverId: saved.id, state: "connected", toolCount: 4 }], auth: { [saved.id]: { state: "signed_out" } } });
}, 15_000);

test("OAuth action opens authorization only after a protected MCP server requests it", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url)), "oauth"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); } });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Protected MCP fixture did not start")), 5000);
    child.stdout.once("data", data => { clearTimeout(timer); resolve(JSON.parse(data.toString()).url); });
  });
  const saved = await f.rpc("mcp.save", { name: "Protected", enabled: true, projectPaths: [f.root], transport: { type: "streamable_http", url } }) as { id: string };
  const start = await f.rpc("mcp.auth.start", { serverId: saved.id }) as { state: string; authorizationUrl?: string };
  expect(start.state).toBe("pending");
  expect(start.authorizationUrl).toContain("/authorize?");
  expect(new URL(start.authorizationUrl!).searchParams.get("code_challenge_method")).toBe("S256");
  expect(await f.rpc("mcp.list", { workspacePath: f.root })).toMatchObject({ auth: { [saved.id]: { state: "pending" } } });
}, 15_000);
