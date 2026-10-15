import { randomUUID } from "node:crypto";
import type { CompleteRequest, CompleteResult, GetPromptResult, Prompt, ReadResourceResult, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectionStatus, McpServerConfig, McpServerInput, McpServerView } from "@harness/protocol";
import { connectMcp, McpConnectionError, type McpConnection, type McpRequestHandlers } from "./mcp-client.js";
import { canonicalMcpProject, mcpProjectKey, McpStore } from "./mcp-store.js";
import type { McpOAuthManager } from "./mcp-oauth.js";

interface Entry {
  key: string;
  config: McpServerConfig;
  project: string;
  controller: AbortController;
  status: McpConnectionStatus;
  ready: Promise<McpConnection>;
  raw?: McpConnection;
  handle?: McpConnection;
  waiters: number;
  catalogRevision: number;
  pins: boolean;
  leases: number;
  requestHandlers?: McpRequestHandlers;
  resourceUpdates: Set<string>;
}

/** Owns connections by server revision and canonical project. Never shares project roots. */
export class McpService {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(readonly store: McpStore, private readonly oauth?: McpOAuthManager) {}

  async save(input: McpServerInput): Promise<McpServerView> {
    if (this.closed) throw new McpConnectionError("closed");
    const previous = input.id ? this.store.get(input.id) : undefined;
    const view = await this.store.save(input);
    await this.invalidate(view.id);
    if (previous && (previous.transport.type !== view.transport.type || (previous.transport.type !== "stdio" && view.transport.type !== "stdio" && previous.transport.url !== view.transport.url))) await this.oauth?.logout(view.id);
    return view;
  }
  async remove(id: string, expectedRevision: number): Promise<void> {
    this.store.remove(id, expectedRevision);
    await this.invalidate(id);
    await this.oauth?.logout(id);
  }
  private current(entry: Entry): boolean {
    const config = this.store.get(entry.config.id);
    return !this.closed && !entry.controller.signal.aborted && this.entries.get(entry.key) === entry &&
      !!config?.enabled && config.revision === entry.config.revision && config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(entry.project));
  }
  private assertCurrent(entry: Entry): void {
    if (!this.current(entry) || entry.raw?.closed) {
      entry.controller.abort();
      void entry.raw?.close();
      throw new McpConnectionError("closed");
    }
  }
  async connect(id: string, workspacePath: string, signal: AbortSignal, pin = true): Promise<McpConnection> {
    return this.connectEntry(id, workspacePath, signal, pin);
  }
  private async connectEntry(id: string, workspacePath: string, signal: AbortSignal, pin: boolean, requestHandlers?: McpRequestHandlers): Promise<McpConnection> {
    const project = await canonicalMcpProject(workspacePath);
    if (this.closed) throw new McpConnectionError("closed");
    if (signal.aborted) throw new McpConnectionError("cancelled");
    const config = this.store.get(id);
    if (!config?.enabled || !config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project))) throw new McpConnectionError("not_allowed");
    const key = JSON.stringify([id, config.revision, mcpProjectKey(project), ...(requestHandlers ? [randomUUID()] : [])]);
    // Discard previous revisions even if configuration was changed through a backend store caller.
    for (const old of this.entries.values()) {
      if (old.config.id === id && old.config.revision !== config.revision) {
        this.entries.delete(old.key); old.controller.abort(); void old.raw?.close();
      }
    }
    let entry = this.entries.get(key);
    if (entry?.raw?.closed || entry?.controller.signal.aborted || entry?.status.state === "error" || entry?.status.state === "auth_required") {
      this.entries.delete(key); entry = undefined;
    }
    if (!entry) {
      entry = {
        key, config, project, controller: new AbortController(), waiters: 0, catalogRevision: 0, pins: pin, leases: 0,
        resourceUpdates: new Set(), ...(requestHandlers ? { requestHandlers } : {}),
        status: { serverId: id, revision: config.revision, workspacePath: project, state: "connecting", toolCount: 0 },
        ready: undefined as unknown as Promise<McpConnection>,
      };
      this.entries.set(key, entry);
      entry.ready = this.establish(entry);
    }
    if (pin) entry.pins = true;
    if (entry.handle) { this.assertCurrent(entry); return entry.handle; }
    entry.waiters++;
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new McpConnectionError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
      });
      return await Promise.race([entry.ready, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
      entry.waiters--;
      if (entry.waiters === 0 && !entry.handle) entry.controller.abort();
    }
  }
  async acquire(id: string, workspacePath: string, signal: AbortSignal, requestHandlers?: McpRequestHandlers): Promise<{ connection: McpConnection; close(): Promise<void> }> {
    const connection = await this.connectEntry(id, workspacePath, signal, false, requestHandlers);
    const entry = [...this.entries.values()].find(value => value.handle === connection);
    if (!entry) throw new McpConnectionError("closed");
    this.assertCurrent(entry); entry.leases++;
    let released = false;
    const close = async () => {
      if (released) return;
      released = true; entry.leases--;
      signal.removeEventListener("abort", cancelled);
      if (entry.leases === 0 && !entry.pins) await connection.close();
    };
    // Reverse requests belong to this run for the entire lease, including after initialization.
    const cancelled = () => { entry.controller.abort(); void close(); };
    if (requestHandlers) {
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) { await close(); throw new McpConnectionError("cancelled"); }
    }
    return { connection, close };
  }
  async secretValues(id: string): Promise<string[]> {
    const config = this.store.get(id);
    let tokens;
    try { tokens = await this.oauth?.provider(id)?.tokens(); } catch { /* Stale credentials are unavailable. */ }
    return [...Object.values(config?.env ?? {}), ...Object.values(config?.headers ?? {}), tokens?.access_token, tokens?.refresh_token]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]);
  }
  private async establish(entry: Entry): Promise<McpConnection> {
    try {
      const authProvider = this.oauth?.provider(entry.config.id);
      const raw = await connectMcp(entry.config, entry.project, entry.controller.signal, {
        ...(authProvider ? { authProvider } : {}),
        ...(entry.requestHandlers ? { requestHandlers: entry.requestHandlers } : {}),
        onToolsChanged: () => { entry.catalogRevision++; },
        onResourcesChanged: () => { entry.catalogRevision++; },
        onPromptsChanged: () => { entry.catalogRevision++; },
        onResourceUpdated: uri => {
          // A notification never fetches resource contents, and pending metadata is bounded.
          if (entry.resourceUpdates.size < 4096 || entry.resourceUpdates.has(uri)) entry.resourceUpdates.add(uri);
          entry.catalogRevision++;
        },
        onClose: () => { entry.status.state = "disconnected"; entry.status.toolCount = 0; entry.status.resourceCount = 0; entry.status.promptCount = 0; },
      });
      entry.raw = raw;
      this.assertCurrent(entry);
      const tools = await raw.listTools(entry.controller.signal);
      this.assertCurrent(entry);
      entry.status = { ...entry.status, state: "connected", toolCount: tools.length, capabilities: { ...raw.capabilities } };
      const current = () => this.current(entry);
      const guarded = async <T>(signal: AbortSignal, operation: (active: AbortSignal) => Promise<T>): Promise<T> => {
        this.assertCurrent(entry);
        try {
          const result = await operation(AbortSignal.any([signal, entry.controller.signal]));
          this.assertCurrent(entry);
          return result;
        } catch (error) {
          if (!this.current(entry)) throw new McpConnectionError("closed");
          throw error;
        }
      };
      const handle: McpConnection = {
        get closed() { return !current() || raw.closed; },
        get capabilities() { return raw.capabilities; },
        listTools: async (signal) => {
          this.assertCurrent(entry);
          const result = await raw.listTools(AbortSignal.any([signal, entry.controller.signal]));
          this.assertCurrent(entry);
          entry.status.toolCount = result.length;
          return result;
        },
        callTool: async (name, input, signal) => {
          return guarded(signal, active => raw.callTool(name, input, active));
        },
        listResources: async signal => {
          const resources = await guarded(signal, active => raw.listResources(active));
          entry.status.resourceCount = resources.length;
          return resources;
        },
        listResourceTemplates: signal => guarded(signal, active => raw.listResourceTemplates(active)),
        readResource: (uri, signal) => guarded(signal, active => raw.readResource(uri, active)),
        listPrompts: async signal => {
          const prompts = await guarded(signal, active => raw.listPrompts(active));
          entry.status.promptCount = prompts.length;
          return prompts;
        },
        getPrompt: (name, args, signal) => guarded(signal, active => raw.getPrompt(name, args, active)),
        complete: (params, signal) => guarded(signal, active => raw.complete(params, active)),
        subscribeResource: (uri, signal) => guarded(signal, active => raw.subscribeResource(uri, active)),
        unsubscribeResource: (uri, signal) => guarded(signal, active => raw.unsubscribeResource(uri, active)),
        close: async () => {
          if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
          entry.controller.abort();
          await raw.close();
        },
      };
      entry.handle = handle;
      return handle;
    } catch (error) {
      await entry.raw?.close();
      const sanitized = entry.controller.signal.aborted ? new McpConnectionError("closed") : error instanceof McpConnectionError ? error : new McpConnectionError("connection_failed");
      entry.status = { ...entry.status, state: sanitized.code === "auth_required" ? "auth_required" : "error", toolCount: 0, error: sanitized.message };
      throw sanitized;
    }
  }
  async tools(id: string, workspacePath: string, signal: AbortSignal): Promise<{ tools: Tool[]; catalogRevision: number }> {
    const connection = await this.connect(id, workspacePath, signal);
    const tools = await connection.listTools(signal);
    const entry = [...this.entries.values()].find(value => value.handle === connection);
    if (!entry) throw new McpConnectionError("closed");
    return { tools, catalogRevision: entry.catalogRevision };
  }
  async resources(id: string, workspacePath: string, signal: AbortSignal): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[]; catalogRevision: number }> {
    const connection = await this.connect(id, workspacePath, signal);
    const [resources, resourceTemplates] = await Promise.all([connection.listResources(signal), connection.listResourceTemplates(signal)]);
    const entry = this.entryFor(connection);
    return { resources, resourceTemplates, catalogRevision: entry.catalogRevision };
  }
  async prompts(id: string, workspacePath: string, signal: AbortSignal): Promise<{ prompts: Prompt[]; catalogRevision: number }> {
    const connection = await this.connect(id, workspacePath, signal);
    const prompts = await connection.listPrompts(signal);
    return { prompts, catalogRevision: this.entryFor(connection).catalogRevision };
  }
  async readResource(id: string, workspacePath: string, uri: string, signal: AbortSignal): Promise<ReadResourceResult> {
    return (await this.connect(id, workspacePath, signal)).readResource(uri, signal);
  }
  async getPrompt(id: string, workspacePath: string, name: string, args: Record<string, string>, signal: AbortSignal): Promise<GetPromptResult> {
    return (await this.connect(id, workspacePath, signal)).getPrompt(name, args, signal);
  }
  async complete(id: string, workspacePath: string, params: CompleteRequest["params"], signal: AbortSignal): Promise<CompleteResult> {
    return (await this.connect(id, workspacePath, signal)).complete(params, signal);
  }
  async subscribeResource(id: string, workspacePath: string, uri: string, signal: AbortSignal): Promise<void> {
    await (await this.connect(id, workspacePath, signal)).subscribeResource(uri, signal);
  }
  async unsubscribeResource(id: string, workspacePath: string, uri: string, signal: AbortSignal): Promise<void> {
    await (await this.connect(id, workspacePath, signal)).unsubscribeResource(uri, signal);
  }
  async resourceUpdates(id: string, workspacePath: string): Promise<{ uris: string[]; catalogRevision: number }> {
    const project = await canonicalMcpProject(workspacePath);
    const config = this.store.get(id);
    if (this.closed) throw new McpConnectionError("closed");
    if (!config?.enabled || !config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project))) throw new McpConnectionError("not_allowed");
    const entry = this.entries.get(JSON.stringify([id, config.revision, mcpProjectKey(project)]));
    if (!entry) return { uris: [], catalogRevision: 0 };
    this.assertCurrent(entry);
    const uris = [...entry.resourceUpdates];
    entry.resourceUpdates.clear();
    return { uris, catalogRevision: entry.catalogRevision };
  }
  private entryFor(connection: McpConnection): Entry {
    const entry = [...this.entries.values()].find(value => value.handle === connection);
    if (!entry) throw new McpConnectionError("closed");
    this.assertCurrent(entry);
    return entry;
  }
  async statuses(workspacePath: string): Promise<McpConnectionStatus[]> {
    const project = await canonicalMcpProject(workspacePath);
    return this.store.list().filter(config => config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project))).map(config => {
      const entry = this.entries.get(JSON.stringify([config.id, config.revision, mcpProjectKey(project)]));
      return structuredClone(entry?.status ?? { serverId: config.id, revision: config.revision, workspacePath: project, state: config.enabled ? "disconnected" : "disabled", toolCount: 0 });
    });
  }
  async disconnect(id: string, workspacePath: string): Promise<void> {
    const project = await canonicalMcpProject(workspacePath);
    await this.revoke(entry => entry.config.id === id && mcpProjectKey(entry.project) === mcpProjectKey(project));
  }
  async invalidate(id: string): Promise<void> { await this.revoke(entry => entry.config.id === id); }
  private async revoke(matches: (entry: Entry) => boolean): Promise<void> {
    const entries = [...this.entries.values()].filter(matches);
    for (const entry of entries) { this.entries.delete(entry.key); entry.controller.abort(); }
    await Promise.all(entries.map(async entry => {
      if (entry.raw) await entry.raw.close();
      else { try { await (await entry.ready).close(); } catch { /* Failed initialization already closes transport. */ } }
    }));
  }
  async close(): Promise<void> { this.closed = true; await this.revoke(() => true); }
}
