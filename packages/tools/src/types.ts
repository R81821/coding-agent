import type { PermissionGrant, RiskLevel, ToolContract } from "@harness/protocol";

export interface ToolContext {
  runId: string;
  workspacePath: string;
  grants: PermissionGrant[];
  signal: AbortSignal;
}

export interface ToolResult {
  output: unknown;
  isError?: boolean;
  truncated?: boolean;
  artifacts?: string[];
}

export interface ToolDefinition {
  contract: ToolContract;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /** Uses its own full input validation so errors can include state-specific recovery data. */
  handlesInputValidation?: boolean;
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
