import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpOAuthManager, McpService, McpStore } from "@harness/extensions";
import { DaemonRequestSchema } from "@harness/protocol";
import { dispatchMcp, isMcpRequest } from "../../daemon/src/mcp-rpc.js";

// Isolated visual/interaction fixture. Uses the actual MCP RPC implementation and encrypted store.
const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-ui-")));
const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-ui-fixture-password");
const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
const store = new McpStore(database);
const mcpAuth: McpOAuthManager = new McpOAuthManager(database, store, id => mcp.invalidate(id));
const mcp: McpService = new McpService(store, mcpAuth);
const serverFile = fileURLToPath(new URL("../../../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
await mcp.save({ name: "项目工具测试服务", enabled: false, projectPaths: [root], transport: { type: "stdio", command: process.execPath, args: [serverFile] } });
// Same fixture in "oauth" mode: it enforces Bearer auth and serves the OAuth discovery,
// registration, authorize and token endpoints, so 「OAuth 登录」 completes a real browser round-trip.
const oauthChild = spawn(process.execPath, [serverFile, "oauth"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const oauthUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
  const timer = setTimeout(() => rejectUrl(new Error("OAuth fixture did not start")), 5000);
  oauthChild.stdout.on("data", data => { clearTimeout(timer); resolveUrl(JSON.parse(data.toString()).url); });
});
await mcp.save({ name: "OAuth 测试服务", enabled: true, projectPaths: [root], transport: { type: "streamable_http", url: oauthUrl } });
const vite = await createViteServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
const html = `<!doctype html><html lang="zh-CN" data-theme="classic"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP management verification</title></head><body><main id="root" style="max-width:1120px;margin:40px auto;padding:24px"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { McpView } from '/src/components/McpView.tsx';
import '/src/tailwind.css'; import '/src/themes.css';
const request = async (input) => { const response = await fetch('/__mcp_test/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({...input,id:crypto.randomUUID()})}); const body = await response.json(); if(!response.ok) throw new Error(body.error); return body; };
window.harness = {request,openExternal: async url => {window.open(url, '_blank', 'noopener');}};
createRoot(document.getElementById('root')).render(React.createElement(McpView,{workspacePath:${JSON.stringify(root)},request}));
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === "/__mcp_test/rpc" && request.method === "POST") {
    if (request.headers.origin && request.headers.origin !== "http://127.0.0.1:5199") { response.writeHead(403).end(); return; }
    try {
      let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 1_100_000) throw new Error("Request too large"); }
      const parsed = DaemonRequestSchema.parse(JSON.parse(body));
      if (!isMcpRequest(parsed)) throw new Error("MCP fixture only");
      const result = await dispatchMcp(parsed, { mcp, mcpAuth });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP request failed" })); }
  } else if (request.url === "/") response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await vite.transformIndexHtml("/", html));
  else vite.middlewares(request, response, () => response.writeHead(404).end());
});
server.listen(5199, "127.0.0.1", () => process.stdout.write("MCP verification UI: http://127.0.0.1:5199\n"));
async function close() {
  await mcp.close(); await mcpAuth.close(); await vite.close(); server.close(); server.closeAllConnections();
  await new Promise<void>(resolveExit => { oauthChild.once("exit", () => resolveExit()); oauthChild.kill(); });
  database.close(); vault.dispose();
  const temp = await realpath(tmpdir());
  if (resolve(root).startsWith(join(temp, "harness-mcp-ui-"))) await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
