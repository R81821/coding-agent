import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema, ListRootsRequestSchema, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServerConfigSchema, type McpServerConfig } from "@harness/protocol";
import { canonicalMcpProject, mcpProjectKey } from "./mcp-store.js";

export type McpErrorCode = "timeout" | "cancelled" | "closed" | "auth_required" | "connection_failed" | "protocol_error" | "not_allowed";
const messages: Record<McpErrorCode, string> = {
  timeout: "MCP request timed out; the remote operation may have started",
  cancelled: "MCP request was cancelled; the remote operation may have started",
  closed: "MCP connection is closed",
  auth_required: "MCP authentication is required",
  connection_failed: "MCP connection failed",
  protocol_error: "MCP server returned an invalid response",
  not_allowed: "MCP server is not enabled for this project",
};
export class McpConnectionError extends Error {
  constructor(readonly code: McpErrorCode) { super(messages[code]); this.name = "McpConnectionError"; }
}
export interface McpConnection {
  readonly closed: boolean;
  listTools(signal: AbortSignal): Promise<Tool[]>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface McpConnectionCallbacks {
  authProvider?: OAuthClientProvider;
  onToolsChanged?: () => void;
  onClose?: () => void;
}
function sanitizedError(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  const code = (error as { code?: unknown })?.code;
  if (code === 401 || (error as { name?: unknown })?.name === "UnauthorizedError") return new McpConnectionError("auth_required");
  if (code === -32001) return new McpConnectionError("timeout");
  if (code === -32000) return new McpConnectionError("closed");
  return new McpConnectionError("connection_failed");
}

/** One project, one server revision. Callers must close a connection when its grant changes. */
export async function connectMcp(raw: McpServerConfig, workspacePath: string, signal: AbortSignal, callbacks: McpConnectionCallbacks = {}): Promise<McpConnection> {
  const config = McpServerConfigSchema.parse(raw);
  const project = await canonicalMcpProject(workspacePath);
  if (!config.enabled || !config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project))) throw new McpConnectionError("not_allowed");
  if (signal.aborted) throw new McpConnectionError("cancelled");
  const lifetime = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const client = new Client({ name: "harness-agent", version: "1.4.3" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: basename(project) }] }));
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { if (!closed) callbacks.onToolsChanged?.(); });
  const markClosed = () => {
    if (closed) return;
    closed = true;
    lifetime.abort(new McpConnectionError("closed"));
    callbacks.onClose?.();
  };
  client.onclose = markClosed;
  // Raw SDK errors can include URLs, server stderr or authorization headers.
  client.onerror = () => {};
  const guardedFetch: FetchLike = (url, init) => fetch(url, {
    ...init, redirect: "error",
    signal: init?.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal,
  });
  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  if (config.transport.type === "stdio") {
    const stdio = new StdioClientTransport({ command: config.transport.command, args: config.transport.args, env: config.env, cwd: config.transport.cwd ?? project, stderr: "pipe" });
    stdio.stderr?.on("data", () => {});
    transport = stdio;
  } else if (config.transport.type === "streamable_http") {
    transport = new StreamableHTTPClientTransport(new URL(config.transport.url), {
      requestInit: { headers: config.headers }, fetch: guardedFetch,
      ...(callbacks.authProvider ? { authProvider: callbacks.authProvider } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  } else {
    transport = new SSEClientTransport(new URL(config.transport.url), { requestInit: { headers: config.headers }, fetch: guardedFetch, ...(callbacks.authProvider ? { authProvider: callbacks.authProvider } : {}) });
  }
  // Client.connect may initiate close without awaiting it. Share the transport's
  // close promise so our failure path also waits for the child process to exit.
  const closeTransport = transport.close.bind(transport);
  let transportClosing: Promise<void> | undefined;
  transport.close = () => transportClosing ??= closeTransport();
  function close(): Promise<void> {
    if (!closing) {
      markClosed();
      closing = (async () => { try { await client.close(); } finally { await transport.close(); } })();
    }
    return closing;
  }
  async function bounded<T>(caller: AbortSignal, timeout: number, operation: (active: AbortSignal) => Promise<T>, initializing = false): Promise<T> {
    if (closed) throw new McpConnectionError("closed");
    if (caller.aborted) throw new McpConnectionError("cancelled");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new McpConnectionError("timeout")), timeout);
    // During initialize the SDK closes before rejecting with the original error.
    // Let that rejection win so an authentication failure is not reported as "closed".
    const active = AbortSignal.any(initializing ? [caller, deadline.signal] : [caller, lifetime.signal, deadline.signal]);
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(closed ? new McpConnectionError("closed") : deadline.signal.aborted ? new McpConnectionError("timeout") : new McpConnectionError("cancelled"));
        active.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([operation(active), aborted]);
    } catch (error) { throw sanitizedError(error); }
    finally { clearTimeout(timer); active.removeEventListener("abort", onAbort); }
  }
  try {
    // SDK 1.x's sessionId getter includes undefined while Transport's optional member does not.
    await bounded(signal, config.connectTimeoutMs, active => client.connect(transport as Transport, { signal: active, timeout: config.connectTimeoutMs }), true);
  } catch (error) { await close(); throw error; }
  return {
    get closed() { return closed; },
    close,
    async listTools(caller) {
      return bounded(caller, config.callTimeoutMs, async active => {
        if (!client.getServerCapabilities()?.tools) return [];
        const tools: Tool[] = [];
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let size = 0;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal: active, timeout: config.callTimeoutMs });
          size += JSON.stringify(page).length;
          if (size > 8_000_000 || tools.length + page.tools.length > 4096) throw new McpConnectionError("protocol_error");
          for (const tool of page.tools) {
            if (names.has(tool.name)) throw new McpConnectionError("protocol_error");
            names.add(tool.name); tools.push(tool);
          }
          cursor = page.nextCursor;
          if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 256)) throw new McpConnectionError("protocol_error");
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        return tools;
      });
    },
    callTool(name, input, caller) {
      // No automatic retry: a disconnected or timed-out write has an uncertain outcome.
      return bounded(caller, config.callTimeoutMs, active => client.callTool({ name, arguments: input }, CallToolResultSchema, { signal: active, timeout: config.callTimeoutMs })) as Promise<CallToolResult>;
    },
  };
}
