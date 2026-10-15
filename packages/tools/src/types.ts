import type { AttachmentRef, PermissionGrant, RiskLevel, ToolContract } from "@harness/protocol";

export interface ToolContext {
  runId: string;
  sessionId?: string;
  workspacePath: string;
  grants: PermissionGrant[];
  signal: AbortSignal;
}

export type ToolImage =
  | { mimeType: string; base64: string; width?: number; height?: number }
  | { attachment: AttachmentRef; detail?: "auto" | "low" | "high" };

export interface ToolResult {
  /** Set only by the runtime's trusted-skill loader, never by external tool payloads. */
  trustedInstruction?: boolean;
  output: unknown;
  isError?: boolean;
  truncated?: boolean;
  artifacts?: string[];
  /** Inline pixels are persisted by the runtime before model dispatch; only attachment refs enter history. */
  images?: ToolImage[];
}

export interface ToolDefinition {
  /** Runtime-reviewed implementation; never supplied by a model or external MCP contract. */
  parallelReadScope?: "workspace" | "stateless";
  /** External reads can transmit project data and must not use local-read defaults. */
  requiresApproval?: boolean;
  external?: { serverId: string; serverName: string; toolName: string; revision: number; contractHash: string };
  contract: ToolContract;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /** Uses its own full input validation so errors can include state-specific recovery data. */
  handlesInputValidation?: boolean;
  /**
   * Runtime-owned tool that performs its own permission and budget accounting (e.g. verification),
   * so the engine must not route it through the durable-registry permission pipeline.
   */
  selfAuthorized?: boolean;
  assessRisk?(input: Record<string, unknown>): RiskLevel;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.contract.name)) throw new Error(`Tool already registered: ${tool.contract.name}`);
    this.tools.set(tool.contract.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean { return this.tools.delete(name); }

  contracts(allowedNames?: string[]): ToolContract[] {
    return [...this.tools.values()].filter((tool) => !allowedNames || (allowedNames.includes(tool.contract.name) || (tool.contract.name === "read_range" && allowedNames.includes("read_file")))).map((tool) => tool.contract);
  }
}
