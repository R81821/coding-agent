import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "stdio";
const sessions = new Map();
const counts = { calls: 0, cancelled: 0 };
let accessVersion = 1;
let oauthOrigin = "";
const codes = new Map();
function makeServer() {
  const server = new Server({ name: "harness-mcp-fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  const tool = name => ({ name, description: `Fixture ${name}`, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { value: { type: process.env.FIXTURE_BAD_SCHEMA ? 42 : "string" } } } });
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    if (process.env.FIXTURE_LOOP_CURSOR) return { tools: [], nextCursor: "loop" };
    if (process.env.FIXTURE_TOOL_COUNT) return { tools: Array.from({ length: Number(process.env.FIXTURE_TOOL_COUNT) }, (_, index) => tool(`echo_${index}`)) };
    if (process.env.FIXTURE_DUPLICATE_TOOLS) return { tools: [tool("echo"), tool("echo")] };
    return request.params?.cursor ? { tools: [tool("slow"), tool("fail"), tool("notify")] } : { tools: [tool("echo")], nextCursor: "page2" };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    counts.calls++;
    if (request.params.arguments?.value === "fixture-media") return { content: [{ type: "image", mimeType: "image/png", data: Buffer.from("fixture-image-data").toString("base64") }, { type: "audio", mimeType: "audio/wav", data: Buffer.from("fixture-audio-data").toString("base64") }, { type: "resource_link", uri: "https://example.test/result", name: "Result" }] };
    if (request.params.name === "slow") {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 10_000);
        extra.signal.addEventListener("abort", () => { counts.cancelled++; clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    if (request.params.name === "fail") return { content: [{ type: "text", text: "Fixture business error" }], isError: true };
    if (request.params.name === "notify") await server.sendToolListChanged();
    const roots = await server.listRoots();
    const output = { arguments: request.params.arguments, cwd: process.cwd(), roots: roots.roots, pid: process.pid, inheritedSecret: process.env.HARNESS_TEST_PARENT_SECRET ?? null, ...counts };
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  });
  return server;
}

if (mode === "stdio") {
  if (process.env.FIXTURE_INIT_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_INIT_DELAY)));
  const server = makeServer();
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
} else {
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (mode === "oauth") {
        const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) { json({ resource: `${oauthOrigin}/mcp`, authorization_servers: [oauthOrigin] }); return; }
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) { json({ issuer: oauthOrigin, authorization_endpoint: `${oauthOrigin}/authorize`, token_endpoint: `${oauthOrigin}/token`, registration_endpoint: `${oauthOrigin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] }); return; }
        if (url.pathname === "/register") {
          let body = ""; for await (const chunk of request) body += chunk;
          json({ ...JSON.parse(body), client_id: "fixture-client" }); return;
        }
        if (url.pathname === "/authorize") {
          const code = randomUUID(); codes.set(code, url.searchParams.get("code_challenge"));
          const callback = new URL(url.searchParams.get("redirect_uri")); callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state"));
          response.writeHead(302, { Location: callback.href }).end(); return;
        }
        if (url.pathname === "/token") {
          let body = ""; for await (const chunk of request) body += chunk;
          const params = new URLSearchParams(body);
          if (params.get("grant_type") === "authorization_code") {
            const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
            if (!codes.has(params.get("code")) || codes.get(params.get("code")) !== challenge) { response.statusCode = 400; json({ error: "invalid_grant" }); return; }
            codes.delete(params.get("code"));
          } else if (params.get("refresh_token") !== "fixture-refresh-secret") { response.statusCode = 400; json({ error: "invalid_grant" }); return; }
          json({ access_token: `fixture-access-secret-${accessVersion}`, refresh_token: "fixture-refresh-secret", token_type: "Bearer", expires_in: 3600 }); return;
        }
        if (url.pathname === "/expire") { accessVersion++; json({ ok: true }); return; }
      }
      const expectedToken = mode === "oauth" ? `Bearer fixture-access-secret-${accessVersion}` : "Bearer fixture-token";
      if (request.headers.authorization !== expectedToken) {
        response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${oauthOrigin}/.well-known/oauth-protected-resource/mcp"` }); response.end("fixture-token must never appear in diagnostics"); return;
      }
      if (mode === "hang") return;
      if (mode === "sse") {
        if (request.method === "GET" && url.pathname === "/sse") {
          const transport = new SSEServerTransport("/messages", response);
          sessions.set(transport.sessionId, transport);
          await makeServer().connect(transport);
        } else {
          const transport = sessions.get(url.searchParams.get("sessionId"));
          if (!transport) { response.writeHead(404).end(); return; }
          await transport.handlePostMessage(request, response);
        }
      } else {
        let transport = sessions.get(request.headers["mcp-session-id"]);
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
          await makeServer().connect(transport);
          await transport.handleRequest(request, response);
          if (transport.sessionId) sessions.set(transport.sessionId, transport);
        } else await transport.handleRequest(request, response);
      }
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  http.listen(0, "127.0.0.1", () => { oauthOrigin = `http://127.0.0.1:${http.address().port}`; process.stdout.write(JSON.stringify({ url: `${oauthOrigin}/${mode === "sse" ? "sse" : "mcp"}` }) + "\n"); });
}
