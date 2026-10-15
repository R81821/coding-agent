import { newId, nowIso, McpInteractionResponseSchema, type McpInteractionResponse, type McpInteractionView } from "@harness/protocol";
import { compileMcpInput, mcpProjectKey, type McpRequestSource } from "@harness/extensions";

interface PendingInteraction {
  view: McpInteractionView;
  validate?: (input: unknown) => boolean;
  resolve(response: McpInteractionResponse): void;
  reject(error: Error): void;
  dispose(): void;
}

/** Remote content cannot echo configured service credentials into the UI or model. */
export function redactMcpValue<T>(value: T, secrets: readonly string[]): T {
  type Position = "root" | "json" | "message" | "content" | "resource";
  const visit = (item: unknown, position: Position = "json"): unknown => {
    if (typeof item === "string") return secrets.reduce((text, secret) => secret ? text.split(secret).join("[redacted]") : text, item);
    if (Array.isArray(item)) return item.map(child => visit(child, position));
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([key, child]) => {
        // Preserve binary only in the protocol's content/resource positions, never
        // in arbitrary structuredContent, metadata or elicitation form fields.
        if (position === "content" && key === "data" && (record.type === "image" || record.type === "audio")
          || position === "resource" && key === "blob") return [key, child];
        const next: Position = position === "root" && key === "messages" ? "message"
          : (position === "root" || position === "message") && key === "content" ? "content"
          : position === "root" && key === "contents" ? "resource"
          : position === "content" && record.type === "resource" && key === "resource" ? "resource" : "json";
        return [key, visit(child, next)];
      }));
    }
    return item;
  };
  return visit(value, "root") as T;
}

/** In-memory user decisions, scoped to the actual server/project/run connection. */
export class McpInteractionBroker {
  private readonly pending = new Map<string, PendingInteraction>();

  request(kind: McpInteractionView["kind"], source: McpRequestSource, params: Record<string, unknown>, signal: AbortSignal,
    context: { runId?: string; modelName?: string } = {}): Promise<McpInteractionResponse> {
    if (signal.aborted) return Promise.reject(new Error("MCP request cancelled"));
    const view: McpInteractionView = { id: newId("mcp_input"), kind, ...source, ...context, createdAt: nowIso(), params: structuredClone(params) };
    const schema = kind === "elicitation" && params.mode !== "url" ? params.requestedSchema : undefined;
    const validate = schema && typeof schema === "object" && !Array.isArray(schema)
      ? compileMcpInput({ ...schema as Record<string, unknown>, additionalProperties: false }) : undefined;
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(view.id);
        signal.removeEventListener("abort", aborted);
        reject(new Error("MCP request cancelled"));
      };
      this.pending.set(view.id, { view, ...(validate ? { validate } : {}), resolve, reject,
        dispose: () => signal.removeEventListener("abort", aborted) });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  list(workspacePath: string, runId?: string): McpInteractionView[] {
    return [...this.pending.values()].filter(item => mcpProjectKey(item.view.workspacePath) === mcpProjectKey(workspacePath)
      && (runId === undefined || item.view.runId === runId)).map(item => structuredClone(item.view));
  }

  respond(raw: McpInteractionResponse): { answered: true } {
    const response = McpInteractionResponseSchema.parse(raw);
    const pending = this.pending.get(response.requestId);
    if (!pending || mcpProjectKey(pending.view.workspacePath) !== mcpProjectKey(response.workspacePath)) throw new Error("MCP request is no longer pending in this project");
    if (response.action === "accept") {
      if (pending.view.kind === "sampling" && response.content !== undefined) throw new Error("Sampling approval cannot replace the server request");
      if (pending.validate && !pending.validate(response.content ?? {})) throw new Error("输入不符合服务要求，请检查必填项和字段格式");
      if (pending.view.params.mode === "url" && response.content !== undefined) throw new Error("URL elicitation does not accept form content");
    }
    this.pending.delete(response.requestId);
    pending.dispose();
    pending.resolve(response);
    return { answered: true };
  }

  cancelRun(runId: string): void {
    for (const [id, pending] of this.pending) if (pending.view.runId === runId) {
      this.pending.delete(id); pending.dispose(); pending.reject(new Error("MCP request cancelled by pause or shutdown"));
    }
  }

  close(): void {
    for (const pending of this.pending.values()) { pending.dispose(); pending.reject(new Error("MCP interactions closed")); }
    this.pending.clear();
  }
}
