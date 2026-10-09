import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@harness/tools";
import { RequirementReceiptSchema } from "@harness/protocol";
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
const requirementAcceptanceInput = z.object({ evidence: z.array(RequirementReceiptSchema.extend({ passed: z.boolean() })).min(1).max(100) });
/** Acceptance can cite runtime evidence; it cannot create a test result or execute a reviewer. */
export function requirementAcceptanceTool(workflow: LightweightWorkflow): ToolDefinition {
  return {
    contract: { name: "check_requirements", description: "After real test suites pass and a fresh complete workspace_diff is read, submit evidence for every stable requirementId exactly once. Each entry requires passed=true, a concrete summary, successful current observationIds, current runtime verificationIds and the complete current diffObservationId. Modification requirements must cite local and required broader test receipts. Model prose and todo status never create passing test evidence. This tool checks recorded evidence only; it does not call an independent model. Then provide the final report.", inputSchema: z.toJSONSchema(requirementAcceptanceInput, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
    handlesInputValidation: true,
    async execute(input) {
      try {
        const { evidence } = requirementAcceptanceInput.parse(input);
        workflow.acceptRequirements(evidence);
        return { output: { accepted: true, requirementsRevision: workflow.state.requirementsRevision, requirementReceipts: workflow.state.requirementReceipts, nextAction: "Provide the final report using these accepted current test and diff receipts." } };
      } catch (error) {
        return { isError: true, output: {
          code: error instanceof z.ZodError ? "requirement_input_invalid" : "requirement_gate_rejected", error: error instanceof Error ? error.message : String(error),
          ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } : {}),
          requirementIds: workflow.state.requirementIds,
          availableObservationIds: workflow.state.observations.filter(item => !item.failed && item.complete && item.epoch === workflow.state.epoch && item.revision === workflow.state.revision).map(item => item.id),
          currentChecks: { local: workflow.state.localCheck, broader: workflow.state.broaderCheck },
          nextAction: "Continue the repair and retest loop: diagnose a failing test, improve code or correct an incorrect test without weakening valid assertions, then rerun local and integration suites and reread the complete diff. For stale references with unchanged code, cite current evidence and keep real passing checks. Correct the named requirement fields and retry check_requirements; this rejection does not end the task.",
        } };
      }
    },
  };
}
export const verificationInput = z.object({ command: z.string().trim().min(1).max(10000), cwd: z.string().default("."), timeoutMs: z.number().int().min(1).max(3600000).default(120000), stdin: z.string().max(1_000_000).optional(), stage: z.enum(["local", "broader"]).default("local") });
export function validateVerificationInput(input: Record<string, unknown>) {
  const parsed = verificationInput.parse(input);
  if (/\b(?:python(?:3|\.exe)?|node(?:\.exe)?|ruby|perl)\b[^\r\n]*\s-\s*$/.test(parsed.command) && !parsed.stdin?.trim()) throw new Error("verification_config_missing: interpreter reading stdin requires a nonempty script");
  return parsed;
}

/** A bounded one-off inspection or experiment. Probes run outside the repository. */
export const probeInput = z.object({ command: z.string().trim().min(1).max(10000), timeoutMs: z.number().int().min(1).max(300_000).default(120_000), stdin: z.string().max(1_000_000).optional() });
export function validateProbeInput(input: Record<string, unknown>) {
  const parsed = probeInput.parse(input);
  if (/\b(?:python(?:3|\.exe)?|node(?:\.exe)?|ruby|perl)\b[^\r\n]*\s-\s*$/.test(parsed.command) && !parsed.stdin?.trim()) throw new Error("probe_config_missing: interpreter reading stdin requires a nonempty script");
  return parsed;
}

/**
 * The isolated probe directory for one run: temporary experiments, their artifacts and their errors
 * stay here, so a probe can never be mistaken for a repository change and never litters the checkout.
 */
export function probeDirectory(runId: string): string {
  return join(tmpdir(), "harness-agent-probe", runId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

/**
 * The program a probe command starts with, used as the scope of its approval: approving `python`
 * probes covers further `python` probes in the same run without retyping the arguments, while a
 * different program still asks again.
 */
export function probeCommandScope(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? command.trim();
  return /^[&$.(\\/'"-]+$/.test(head) && tokens[1] ? `${head} ${tokens[1]}` : head;
}
