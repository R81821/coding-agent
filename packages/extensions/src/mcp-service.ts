import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectionStatus, McpServerConfig, McpServerInput, McpServerView } from "@harness/protocol";
import { connectMcp, McpConnectionError, type McpConnection } from "./mcp-client.js";
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
    const project = await canonicalMcpProject(workspacePath);
    if (this.closed) throw new McpConnectionError("closed");
    if (signal.aborted) throw new McpConnectionError("cancelled");
    const config = this.store.get(id);
    if (!config?.enabled || !config.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project))) throw new McpConnectionError("not_allowed");
    const key = JSON.stringify([id, config.revision, mcpProjectKey(project)]);
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
  async acquire(id: string, workspacePath: string, signal: AbortSignal): Promise<{ connection: McpConnection; close(): Promise<void> }> {
    const connection = await this.connect(id, workspacePath, signal, false);
    const entry = [...this.entries.values()].find(value => value.handle === connection);
    if (!entry) throw new McpConnectionError("closed");
    this.assertCurrent(entry); entry.leases++;
    let released = false;
    return { connection, close: async () => {
      if (released) return;
      released = true; entry.leases--;
      if (entry.leases === 0 && !entry.pins) await connection.close();
    } };
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
        onToolsChanged: () => { entry.catalogRevision++; },
        onClose: () => { entry.status.state = "disconnected"; entry.status.toolCount = 0; },
      });
      entry.raw = raw;
      this.assertCurrent(entry);
      const tools = await raw.listTools(entry.controller.signal);
      this.assertCurrent(entry);
      entry.status = { ...entry.status, state: "connected", toolCount: tools.length };
      const current = () => this.current(entry);
      const handle: McpConnection = {
        get closed() { return !current() || raw.closed; },
        listTools: async (signal) => {
          this.assertCurrent(entry);
          const result = await raw.listTools(AbortSignal.any([signal, entry.controller.signal]));
          this.assertCurrent(entry);
          entry.status.toolCount = result.length;
          return result;
        },
        callTool: async (name, input, signal) => {
          this.assertCurrent(entry);
          try {
            const result = await raw.callTool(name, input, AbortSignal.any([signal, entry.controller.signal]));
            this.assertCurrent(entry);
            return result;
          } catch (error) {
            if (!this.current(entry)) throw new McpConnectionError("closed");
            throw error;
          }
        },
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
