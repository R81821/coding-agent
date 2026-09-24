import type { DaemonRequest, McpRequest, McpManagementSnapshot } from "@harness/protocol";
import { canonicalMcpProject, previewMcpImport, type McpService, type McpOAuthManager } from "@harness/extensions";

export function isMcpRequest(request: DaemonRequest): request is McpRequest { return request.method.startsWith("mcp."); }
interface McpRuntime { mcp: McpService; mcpAuth: McpOAuthManager }
export async function dispatchMcp(request: McpRequest, runtime: McpRuntime): Promise<unknown> {
  const { mcp, mcpAuth } = runtime;
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
    case "mcp.auth.start": return mcpAuth.start(request.params.serverId);
    case "mcp.auth.logout": await mcpAuth.logout(request.params.serverId); return { signedOut: true };
    case "mcp.import": return previewMcpImport(request.params.source, await canonicalMcpProject(request.params.workspacePath));
  }
}
