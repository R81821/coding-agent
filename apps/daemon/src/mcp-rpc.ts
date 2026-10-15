import type { DaemonRequest, McpRequest, McpManagementSnapshot } from "@harness/protocol";
import { canonicalMcpProject, McpConnectionError, previewMcpImport, type McpService, type McpOAuthManager } from "@harness/extensions";
import { redactMcpValue, type HarnessEngine } from "@harness/core";

export function isMcpRequest(request: DaemonRequest): request is McpRequest { return request.method.startsWith("mcp."); }
interface McpRuntime { mcp: McpService; mcpAuth: McpOAuthManager; engine?: Pick<HarnessEngine, "mcpInteractions"> }
export async function dispatchMcp(request: McpRequest, runtime: McpRuntime): Promise<unknown> {
  const { mcp, mcpAuth } = runtime;
  const signal = new AbortController().signal;
  const safe = async <T>(serverId: string, result: Promise<T>): Promise<T> => redactMcpValue(await result, await mcp.secretValues(serverId));
  switch (request.method) {
    case "mcp.list": {
      const servers = mcp.store.list();
      return { servers, statuses: request.params.workspacePath ? await mcp.statuses(request.params.workspacePath) : [], auth: Object.fromEntries(servers.map(server => [server.id, mcpAuth.status(server.id)])) } satisfies McpManagementSnapshot;
    }
    case "mcp.save": return mcp.save(request.params);
    case "mcp.remove": await mcp.remove(request.params.serverId, request.params.expectedRevision); return { removed: true };
    case "mcp.connect": {
      await mcp.connect(request.params.serverId, request.params.workspacePath, new AbortController().signal);
      return (await mcp.statuses(request.params.workspacePath)).find(status => status.serverId === request.params.serverId);
    }
    case "mcp.disconnect": await mcp.disconnect(request.params.serverId, request.params.workspacePath); return { disconnected: true };
    case "mcp.tools": return mcp.tools(request.params.serverId, request.params.workspacePath, new AbortController().signal);
    case "mcp.resources": return safe(request.params.serverId, mcp.resources(request.params.serverId, request.params.workspacePath, signal));
    case "mcp.resource.read": return safe(request.params.serverId, mcp.readResource(request.params.serverId, request.params.workspacePath, request.params.uri, signal));
    case "mcp.resource.subscribe": await mcp.subscribeResource(request.params.serverId, request.params.workspacePath, request.params.uri, signal); return { subscribed: true };
    case "mcp.resource.unsubscribe": await mcp.unsubscribeResource(request.params.serverId, request.params.workspacePath, request.params.uri, signal); return { subscribed: false };
    case "mcp.resource.updates": return safe(request.params.serverId, mcp.resourceUpdates(request.params.serverId, request.params.workspacePath));
    case "mcp.prompts": return safe(request.params.serverId, mcp.prompts(request.params.serverId, request.params.workspacePath, signal));
    case "mcp.prompt.get": return safe(request.params.serverId, mcp.getPrompt(request.params.serverId, request.params.workspacePath, request.params.name, request.params.arguments, signal));
    case "mcp.completion": {
      const { serverId, workspacePath, ...params } = request.params;
      return safe(serverId, mcp.complete(serverId, workspacePath, params, signal));
    }
    case "mcp.interactions.list": return { requests: runtime.engine?.mcpInteractions.list(await canonicalMcpProject(request.params.workspacePath), request.params.runId) ?? [] };
    case "mcp.interactions.respond": {
      if (!runtime.engine) throw new Error("MCP interaction runtime is unavailable");
      return runtime.engine.mcpInteractions.respond({ ...request.params, workspacePath: await canonicalMcpProject(request.params.workspacePath) });
    }
    case "mcp.auth.start": {
      const server = mcp.store.get(request.params.serverId);
      if (!server?.enabled || !server.projectPaths.length) throw new McpConnectionError("not_allowed");
      try {
        await mcp.connect(server.id, server.projectPaths[0]!, new AbortController().signal);
        return { state: "not_required" as const };
      } catch (error) {
        if (!(error instanceof McpConnectionError) || error.code !== "auth_required") throw error;
        return mcpAuth.start(server.id);
      }
    }
    case "mcp.auth.logout": await mcpAuth.logout(request.params.serverId); return { signedOut: true };
    case "mcp.import": return previewMcpImport(request.params.source, await canonicalMcpProject(request.params.workspacePath));
  }
}
