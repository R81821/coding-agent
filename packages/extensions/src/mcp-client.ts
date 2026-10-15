import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolResultSchema, CancelledNotificationSchema, CompleteRequestSchema, CreateMessageRequestSchema, CreateMessageResultSchema,
  ElicitRequestSchema, ElicitResultSchema, ErrorCode, GetPromptRequestSchema, ListRootsRequestSchema, McpError,
  PromptListChangedNotificationSchema, ReadResourceRequestSchema, ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema, ToolListChangedNotificationSchema,
  type CallToolResult, type CompleteRequest, type CompleteResult, type CreateMessageRequest, type CreateMessageResult,
  type ElicitRequest, type ElicitResult, type GetPromptResult, type Prompt, type ReadResourceResult,
  type RequestId, type Resource, type ResourceTemplate, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
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
  readonly capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  listTools(signal: AbortSignal): Promise<Tool[]>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  listResources(signal: AbortSignal): Promise<Resource[]>;
  listResourceTemplates(signal: AbortSignal): Promise<ResourceTemplate[]>;
  readResource(uri: string, signal: AbortSignal): Promise<ReadResourceResult>;
  listPrompts(signal: AbortSignal): Promise<Prompt[]>;
  getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<GetPromptResult>;
  complete(params: CompleteRequest["params"], signal: AbortSignal): Promise<CompleteResult>;
  subscribeResource(uri: string, signal: AbortSignal): Promise<void>;
  unsubscribeResource(uri: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface McpRequestSource { serverId: string; serverName: string; workspacePath: string }
export interface McpRequestHandlers {
  onSampling?(params: CreateMessageRequest["params"], signal: AbortSignal, source: McpRequestSource): Promise<CreateMessageResult>;
  onElicitation?(params: ElicitRequest["params"], signal: AbortSignal, source: McpRequestSource): Promise<ElicitResult>;
}
export interface McpConnectionCallbacks {
  authProvider?: OAuthClientProvider;
  requestHandlers?: McpRequestHandlers;
  onToolsChanged?: () => void;
  onResourcesChanged?: () => void;
  onPromptsChanged?: () => void;
  onResourceUpdated?: (uri: string) => void;
  onClose?: () => void;
}
function sanitizedError(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  const code = (error as { code?: unknown })?.code;
  if (code === 401 || (error as { name?: unknown })?.name === "UnauthorizedError") return new McpConnectionError("auth_required");
  if (code === -32001) return new McpConnectionError("timeout");
  if (code === -32000) return new McpConnectionError("closed");
  const name = (error as { name?: unknown })?.name;
  if (code === ErrorCode.InvalidParams || code === ErrorCode.InvalidRequest || name === "ZodError" || name === "$ZodError") return new McpConnectionError("protocol_error");
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
  const requestHandlers = callbacks.requestHandlers;
  const reverseRequests = new Map<RequestId, AbortController>();
  const source: McpRequestSource = { serverId: config.id, serverName: config.name, workspacePath: project };
  const client = new Client({ name: "harness-agent", version: "1.4.51" }, { capabilities: {
    roots: { listChanged: true },
    ...(requestHandlers?.onSampling ? { sampling: {} } : {}),
    ...(requestHandlers?.onElicitation ? { elicitation: { form: {}, url: {} } } : {}),
  } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: basename(project) }] }));
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { if (!closed) callbacks.onToolsChanged?.(); });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { if (!closed) callbacks.onResourcesChanged?.(); });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => { if (!closed) callbacks.onPromptsChanged?.(); });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { if (!closed) callbacks.onResourceUpdated?.(notification.params.uri); });
  if (requestHandlers?.onSampling || requestHandlers?.onElicitation) client.setNotificationHandler(CancelledNotificationSchema, notification => {
    // SDK 1.30 ignores cancellation of request ID 0. Track our reverse handlers explicitly;
    // all other client-side handlers complete synchronously and no task capability is advertised.
    if (notification.params.requestId !== undefined) reverseRequests.get(notification.params.requestId)?.abort(new McpConnectionError("cancelled"));
  });
  async function reverse<T>(requestId: RequestId, signal: AbortSignal, operation: (active: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    reverseRequests.set(requestId, controller);
    try { return await bounded(AbortSignal.any([signal, controller.signal]), config.callTimeoutMs, operation); }
    finally { if (reverseRequests.get(requestId) === controller) reverseRequests.delete(requestId); }
  }
  if (requestHandlers?.onSampling) client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
    try {
      return await reverse(extra.requestId, extra.signal, async active => {
        const result = await requestHandlers.onSampling!(request.params, active, { ...source });
        const validated = CreateMessageResultSchema.safeParse(result);
        if (!validated.success) throw new McpConnectionError("protocol_error");
        return validated.data;
      });
    } catch (error) { throw new McpError(ErrorCode.InternalError, sanitizedError(error).message); }
  });
  if (requestHandlers?.onElicitation) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    try {
      return await reverse(extra.requestId, extra.signal, async active => {
        const result = await requestHandlers.onElicitation!(request.params, active, { ...source });
        const validated = ElicitResultSchema.safeParse(result);
        if (!validated.success) throw new McpConnectionError("protocol_error");
        return validated.data;
      });
    } catch (error) { throw new McpError(ErrorCode.InternalError, sanitizedError(error).message); }
  });
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
  const capabilities = {
    tools: !!client.getServerCapabilities()?.tools,
    resources: !!client.getServerCapabilities()?.resources,
    prompts: !!client.getServerCapabilities()?.prompts,
  };
  // One deadline covers every page, with the same defensive limits for all catalogs.
  async function list<T>(caller: AbortSignal, enabled: boolean, page: (cursor: string | undefined, active: AbortSignal) => Promise<{ items: T[]; nextCursor?: string }>, identity: (item: T) => string): Promise<T[]> {
    return bounded(caller, config.callTimeoutMs, async active => {
      if (!enabled) return [];
      const items: T[] = [], names = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined, size = 0;
      do {
        const result = await page(cursor, active);
        size += JSON.stringify(result).length;
        if (size > 8_000_000 || items.length + result.items.length > 4096) throw new McpConnectionError("protocol_error");
        for (const item of result.items) {
          const name = identity(item);
          if (names.has(name)) throw new McpConnectionError("protocol_error");
          names.add(name); items.push(item);
        }
        cursor = result.nextCursor;
        if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 256)) throw new McpConnectionError("protocol_error");
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
      return items;
    });
  }
  function validated<T>(value: T, schema: { safeParse(value: unknown): { success: boolean } }): T {
    if (!schema.safeParse(value).success) throw new McpConnectionError("protocol_error");
    return value;
  }
  return {
    get closed() { return closed; },
    get capabilities() { return { ...capabilities }; },
    close,
    listTools(caller) {
      return list(caller, capabilities.tools, async (cursor, active) => {
        const page = await client.listTools(cursor !== undefined ? { cursor } : {}, { signal: active, timeout: config.callTimeoutMs });
        return { items: page.tools, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
      }, item => item.name);
    },
    listResources(caller) {
      return list(caller, capabilities.resources, async (cursor, active) => {
        try {
          const page = await client.listResources(cursor !== undefined ? { cursor } : {}, { signal: active, timeout: config.callTimeoutMs });
          return { items: page.resources, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
        } catch (error) {
          // Resource servers may expose templates or known URIs without a static resource catalog.
          if (cursor === undefined && (error as { code?: unknown })?.code === ErrorCode.MethodNotFound) return { items: [] };
          throw error;
        }
      }, item => item.uri);
    },
    listResourceTemplates(caller) {
      return list(caller, capabilities.resources, async (cursor, active) => {
        try {
          const page = await client.listResourceTemplates(cursor !== undefined ? { cursor } : {}, { signal: active, timeout: config.callTimeoutMs });
          return { items: page.resourceTemplates, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
        } catch (error) {
          if (cursor === undefined && (error as { code?: unknown })?.code === ErrorCode.MethodNotFound) return { items: [] };
          throw error;
        }
      }, item => item.uriTemplate);
    },
    listPrompts(caller) {
      return list(caller, capabilities.prompts, async (cursor, active) => {
        const page = await client.listPrompts(cursor !== undefined ? { cursor } : {}, { signal: active, timeout: config.callTimeoutMs });
        return { items: page.prompts, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
      }, item => item.name);
    },
    readResource(uri, caller) {
      const params = validated({ uri }, ReadResourceRequestSchema.shape.params);
      return bounded(caller, config.callTimeoutMs, active => client.readResource(params, { signal: active, timeout: config.callTimeoutMs }));
    },
    getPrompt(name, args, caller) {
      const params = validated({ name, arguments: args }, GetPromptRequestSchema.shape.params);
      return bounded(caller, config.callTimeoutMs, active => client.getPrompt(params, { signal: active, timeout: config.callTimeoutMs }));
    },
    complete(params, caller) {
      validated(params, CompleteRequestSchema.shape.params);
      return bounded(caller, config.callTimeoutMs, active => client.complete(params, { signal: active, timeout: config.callTimeoutMs }));
    },
    async subscribeResource(uri, caller) {
      const params = validated({ uri }, ReadResourceRequestSchema.shape.params);
      await bounded(caller, config.callTimeoutMs, active => client.subscribeResource(params, { signal: active, timeout: config.callTimeoutMs }));
    },
    async unsubscribeResource(uri, caller) {
      const params = validated({ uri }, ReadResourceRequestSchema.shape.params);
      await bounded(caller, config.callTimeoutMs, active => client.unsubscribeResource(params, { signal: active, timeout: config.callTimeoutMs }));
    },
    callTool(name, input, caller) {
      // No automatic retry: a disconnected or timed-out write has an uncertain outcome.
      return bounded(caller, config.callTimeoutMs, active => client.callTool({ name, arguments: input }, CallToolResultSchema, { signal: active, timeout: config.callTimeoutMs })) as Promise<CallToolResult>;
    },
  };
}
