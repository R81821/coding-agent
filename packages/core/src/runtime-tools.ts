import { z } from "zod";
import type { ToolDefinition } from "@harness/tools";
import type { LightweightWorkflow } from "./lightweight-workflow.js";
const todoInput = z.object({ items: z.array(z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(300), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) })).max(20).optional() });
export function todoTool(workflow: LightweightWorkflow): ToolDefinition {
  return {
    contract: { name: "todo", description: "Query tasks or merge changed tasks by ID. Maximum 20 tasks, 300 characters each. Plan status never substitutes for verification.", inputSchema: z.toJSONSchema(todoInput, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
    async execute(input) {
      const { items } = todoInput.parse(input);
      const merged = new Map((workflow.state.todos ?? []).map(item => [item.id, item]));
      for (const item of items ?? []) merged.set(item.id, item);
      if (merged.size > 20) return { isError: true, output: { code: "todo_limit", limit: 20 } };
      workflow.state.todos = [...merged.values()];
      workflow.move(workflow.state.phase, "任务计划已更新");
      return { output: { items: items ?? workflow.state.todos, count: merged.size, completed: workflow.state.todos.filter(item => item.status === "completed").length } };
    },
  };
}
export const verificationInput = z.object({ command: z.string().trim().min(1).max(10000), cwd: z.string().default("."), timeoutMs: z.number().int().min(1).max(3600000).default(120000), stdin: z.string().max(1_000_000).optional(), stage: z.enum(["local", "broader"]).default("local") });
export function validateVerificationInput(input: Record<string, unknown>) {
  const parsed = verificationInput.parse(input);
  if (/\b(?:python(?:3|\.exe)?|node(?:\.exe)?|ruby|perl)\b[^\r\n]*\s-\s*$/.test(parsed.command) && !parsed.stdin?.trim()) throw new Error("verification_config_missing: interpreter reading stdin requires a nonempty script");
  return parsed;
}
