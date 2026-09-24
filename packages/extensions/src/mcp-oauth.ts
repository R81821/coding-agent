import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HarnessDatabase } from "@harness/persistence";
import type { McpAuthStatus } from "@harness/protocol";
import { McpConnectionError } from "./mcp-client.js";
import type { McpStore } from "./mcp-store.js";

interface AuthRecord {
  epoch: string;
  serverUrl: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}
interface Flow {
  server: Server;
  controller: AbortController;
  state: string;
  authorizationUrl?: string;
  consumed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** OAuth secrets remain in the encrypted database; the renderer sees only status and a login URL. */
export class McpOAuthManager {
  private readonly flows = new Map<string, Flow>();
  private readonly errors = new Map<string, string>();
  private closed = false;
  constructor(private readonly database: HarnessDatabase, private readonly store: McpStore, private readonly onChanged: (id: string) => Promise<void> = async () => {}) {}

  private record(id: string): AuthRecord | undefined {
    const config = this.store.get(id);
    const record = this.database.getMcpAuth<AuthRecord>(id);
    return config && config.transport.type !== "stdio" && record?.serverUrl === config.transport.url ? record : undefined;
  }
  status(id: string): McpAuthStatus {
    const error = this.errors.get(id);
    return this.flows.has(id) ? { state: "pending" } : error ? { state: "error", error } : { state: this.record(id)?.tokens ? "authorized" : "signed_out" };
  }
  provider(id: string): OAuthClientProvider | undefined {
    const initial = this.record(id);
    if (!initial || this.closed) return undefined;
    const current = () => {
      const value = this.record(id);
      if (this.closed || !value || value.epoch !== initial.epoch) throw new McpConnectionError("auth_required");
      return value;
    };
    const update = (change: (value: AuthRecord) => void) => { const value = current(); change(value); this.database.saveMcpAuth(id, value); };
    return {
      redirectUrl: initial.redirectUrl,
      clientMetadata: { client_name: "Harness Agent", redirect_uris: [initial.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      state: () => { current(); const flow = this.flows.get(id); if (!flow) throw new McpConnectionError("auth_required"); return flow.state; },
      clientInformation: () => current().client,
      saveClientInformation: client => update(value => { value.client = client; }),
      tokens: () => current().tokens,
      saveTokens: tokens => update(value => { value.tokens = tokens; delete value.verifier; }),
      saveCodeVerifier: verifier => update(value => { value.verifier = verifier; }),
      codeVerifier: () => { const verifier = current().verifier; if (!verifier) throw new McpConnectionError("auth_required"); return verifier; },
      redirectToAuthorization: url => {
        current(); const flow = this.flows.get(id);
        if (!flow || flow.consumed || !this.allowedUrl(url, initial.serverUrl)) throw new McpConnectionError("auth_required");
        flow.authorizationUrl = url.href;
      },
      invalidateCredentials: scope => update(value => {
        if (scope === "all" || scope === "client") delete value.client;
        if (scope === "all" || scope === "tokens") delete value.tokens;
        if (scope === "all" || scope === "verifier") delete value.verifier;
      }),
    };
  }
  private allowedUrl(url: URL, serverUrl: string): boolean {
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && (url.origin === new URL(serverUrl).origin || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))));
  }
  private fetchFor(flow: Flow, serverUrl: string): FetchLike {
    return (url, init) => {
      if (!this.allowedUrl(new URL(url instanceof Request ? url.url : String(url)), serverUrl)) throw new McpConnectionError("auth_required");
      return fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) });
    };
  }
  async start(id: string): Promise<{ authorizationUrl?: string; state: McpAuthStatus["state"] }> {
    if (this.closed) throw new McpConnectionError("closed");
    const config = this.store.get(id);
    if (!config || config.transport.type === "stdio") throw new Error("OAuth requires a remote MCP server");
    const serverUrl = config.transport.url;
    await this.logout(id);
    const flow: Flow = { server: createServer(), controller: new AbortController(), state: randomBytes(32).toString("base64url"), consumed: false };
    this.flows.set(id, flow);
    try {
      await new Promise<void>((resolve, reject) => { flow.server.once("error", reject); flow.server.listen(0, "127.0.0.1", resolve); });
      const address = flow.server.address();
      if (!address || typeof address === "string") throw new Error("OAuth callback unavailable");
      const redirectUrl = `http://127.0.0.1:${address.port}/mcp/oauth/callback`;
      this.database.saveMcpAuth(id, { epoch: randomBytes(24).toString("hex"), serverUrl, redirectUrl } satisfies AuthRecord);
      const provider = this.provider(id)!;
      flow.server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUrl);
        const providedState = Buffer.from(url.searchParams.get("state") ?? "");
        const expectedState = Buffer.from(flow.state);
        if (request.method !== "GET" || url.pathname !== "/mcp/oauth/callback" || flow.consumed || providedState.length !== expectedState.length || !timingSafeEqual(providedState, expectedState)) { response.writeHead(400).end("Invalid OAuth callback"); return; }
        flow.consumed = true;
        void (async () => {
          try {
            const code = url.searchParams.get("code");
            if (!code || url.searchParams.has("error")) throw new McpConnectionError("auth_required");
            const result = await auth(provider, { serverUrl, authorizationCode: code, fetchFn: this.fetchFor(flow, serverUrl) });
            if (result !== "AUTHORIZED") throw new McpConnectionError("auth_required");
            await this.onChanged(id);
            response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("MCP login complete. You can close this window and return to Harness.");
          } catch {
            this.errors.set(id, "MCP OAuth login failed; try signing in again");
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("MCP login failed. Return to Harness to try again.");
          } finally { await this.stopFlow(id, flow); }
        })();
      });
      flow.timer = setTimeout(() => { this.errors.set(id, "MCP OAuth login expired"); void this.stopFlow(id, flow); }, 5 * 60_000);
      flow.timer.unref();
      const result = await auth(provider, { serverUrl, fetchFn: this.fetchFor(flow, serverUrl) });
      if (result === "AUTHORIZED") { await this.stopFlow(id, flow); return { state: "authorized" }; }
      if (!flow.authorizationUrl) throw new McpConnectionError("auth_required");
      return { authorizationUrl: flow.authorizationUrl, state: "pending" };
    } catch {
      await this.stopFlow(id, flow);
      this.errors.set(id, "MCP OAuth login could not start");
      throw new McpConnectionError("auth_required");
    }
  }
  private async stopFlow(id: string, flow: Flow): Promise<void> {
    if (this.flows.get(id) === flow) this.flows.delete(id);
    if (flow.timer) clearTimeout(flow.timer);
    flow.controller.abort();
    await new Promise<void>(resolve => { flow.server.close(() => resolve()); flow.server.closeIdleConnections(); });
  }
  async logout(id: string): Promise<void> {
    this.database.deleteMcpAuth(id);
    this.errors.delete(id);
    const flow = this.flows.get(id);
    if (flow) await this.stopFlow(id, flow);
    await this.onChanged(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.flows].map(([id, flow]) => this.stopFlow(id, flow)));
  }
}
