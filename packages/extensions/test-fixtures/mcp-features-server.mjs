import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, CompleteRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "stdio";
const resource = uri => ({ uri, name: uri.slice(10), mimeType: "text/plain" });
const template = uriTemplate => ({ uriTemplate, name: uriTemplate.slice(10) });
const prompt = name => ({ name, arguments: [{ name: "topic", required: true }] });
function makeServer() {
  const server = new Server({ name: "harness-mcp-features-fixture", version: "1.0.0" }, { capabilities: {
    ...(process.env.FIXTURE_NO_TOOLS ? {} : { tools: { listChanged: true } }),
    resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true }, completions: {},
  } });
  const session = randomUUID(), subscribed = new Set();
  let reads = 0, cancelled = 0;
  async function delay(signal) {
    await new Promise(resolve => {
      if (signal.aborted) { cancelled++; resolve(); return; }
      const timer = setTimeout(resolve, 10_000);
      signal.addEventListener("abort", () => { cancelled++; clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  const catalog = async (params, extra, items) => {
    if (process.env.FIXTURE_SLOW_LIST) await delay(extra.signal);
    if (process.env.FIXTURE_LOOP_LIST) return { values: [], nextCursor: "loop" };
    if (process.env.FIXTURE_DUPLICATE_LIST) return { values: [items[0], items[0]] };
    if (process.env.FIXTURE_OVERSIZED_LIST) return { values: items.map(item => ({ ...item, description: "x".repeat(4_000_001) })) };
    if (process.env.FIXTURE_INVALID_LIST) return { values: [42] };
    return params?.cursor !== undefined ? { values: [items[1]] } : { values: [items[0]], nextCursor: "page2" };
  };
  if (!process.env.FIXTURE_NO_TOOLS) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "inspect", inputSchema: { type: "object" } }, { name: "notify", inputSchema: { type: "object" } }, { name: "sample", inputSchema: { type: "object" } }, { name: "form", inputSchema: { type: "object" } }, { name: "url", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const operation = request.params.name;
      let value;
      if (operation === "sample") value = await server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Fixture sampling request" } }], maxTokens: 64, systemPrompt: "Fixture system prompt" }, { signal: extra.signal, relatedRequestId: extra.requestId });
      else if (operation === "form") value = await server.elicitInput({ mode: "form", message: "Choose a topic", requestedSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } }, { signal: extra.signal, relatedRequestId: extra.requestId });
      else if (operation === "url") value = await server.elicitInput({ mode: "url", message: "Sign in to fixture", url: "https://example.test/authorize", elicitationId: "fixture-auth" }, { signal: extra.signal, relatedRequestId: extra.requestId });
      else {
        if (operation === "notify") {
          await server.sendResourceListChanged(); await server.sendPromptListChanged();
          for (const uri of subscribed) await server.sendResourceUpdated({ uri });
        }
        const roots = await server.listRoots();
        value = { session, pid: process.pid, reads, cancelled, subscribed: [...subscribed], capabilities: server.getClientCapabilities(), roots: roots.roots };
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    });
  }
  if (!process.env.FIXTURE_NO_RESOURCE_LIST) server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
    const result = await catalog(request.params, extra, [resource("fixture://first"), resource("fixture://second")]);
    return { resources: result.values, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}) };
  });
  if (!process.env.FIXTURE_NO_TEMPLATE_LIST) server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
    const result = await catalog(request.params, extra, [template("fixture://topics/{topic}"), template("fixture://files/{name}")]);
    return { resourceTemplates: result.values, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}) };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
    const result = await catalog(request.params, extra, [prompt("review"), prompt("explain")]);
    return { prompts: result.values, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}) };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    reads++;
    if (request.params.uri === "fixture://slow") await delay(extra.signal);
    if (request.params.uri === "fixture://binary") return { contents: [{ uri: request.params.uri, mimeType: "application/octet-stream", blob: Buffer.from("fixture binary").toString("base64") }] };
    return { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: `${request.params.uri} read ${reads}` }] };
  });
  server.setRequestHandler(GetPromptRequestSchema, async request => ({ description: request.params.name, messages: [
    { role: "user", content: { type: "text", text: `Review ${request.params.arguments?.topic ?? "missing"}` } },
    { role: "assistant", content: { type: "resource", resource: { uri: "fixture://embedded", text: "Reference content" } } },
    { role: "user", content: { type: "image", mimeType: "image/png", data: Buffer.from("fixture image").toString("base64") } },
  ] }));
  server.setRequestHandler(CompleteRequestSchema, async request => ({ completion: { values: [request.params.argument.value + "-one", request.params.argument.value + "-two"], total: 2, hasMore: false } }));
  server.setRequestHandler(SubscribeRequestSchema, async request => { subscribed.add(request.params.uri); return {}; });
  server.setRequestHandler(UnsubscribeRequestSchema, async request => { subscribed.delete(request.params.uri); return {}; });
  return server;
}

if (mode === "stdio") {
  await makeServer().connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
} else {
  const sessions = new Map();
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
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
  // Use the fixture's dynamic safe-port retry, because Windows may assign Fetch-forbidden ports.
  const forbidden = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
  function listen() {
    http.listen(0, "127.0.0.1", () => {
      if (forbidden.has(http.address().port)) { http.close(listen); return; }
      process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${http.address().port}/${mode === "sse" ? "sse" : "mcp"}` }) + "\n");
    });
  }
  listen();
}
