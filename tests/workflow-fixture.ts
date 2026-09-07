import type { ProviderStreamEvent } from "@harness/providers";
import type { ToolDefinition } from "@harness/tools";
export const workflowReadTool: ToolDefinition = {
  contract: { name: "read_file", description: "Read fixture", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
  async execute() { return { output: "export const value = 'alpha'; // target and test evidence" }; },
};
export const workflowCall = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
export function workflowPrelude(turn: number): ProviderStreamEvent[] {
  if (turn === 1) return [workflowCall("understand", "update_workflow", { action: "understand", intent: "change", requirements: ["Correct the target value and preserve compatibility"] })];
  if (turn === 2) return [workflowCall("recon", "read_file", { path: "src/value.ts" })];
  if (turn === 3) return [workflowCall("plan", "update_workflow", { action: "plan", context: "The target and its test use the old value", steps: ["Apply minimal change", "Verify behavior"], cause: "The target uses an outdated value", evidenceIds: ["recon"] })];
  return [];
}