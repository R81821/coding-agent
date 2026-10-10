import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@harness/tools";
import { RequirementEvidenceSchema } from "@harness/protocol";
import type { LightweightWorkflow } from "./lightweight-workflow.js";
import { MANUAL_TODO_LIMIT, WORKFLOW_TODO_LIMIT, synchronizeWorkflowTodos } from "./workflow-tasks.js";
const todoInput = z.object({ items: z.array(z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(300), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) })).max(WORKFLOW_TODO_LIMIT).optional() });
export function todoTool(workflow: LightweightWorkflow): ToolDefinition {
  return {
    contract: { name: "todo", description: "Query tasks or merge manual tasks by ID. Plan steps are projected automatically: pending/in_progress come from advance_workflow; completed comes only from real passing verification. Use advance_workflow to edit plan text or step progress. Maximum 20 additional manual tasks and 40 total tasks, 300 characters each. Todo status never substitutes for verification. Queries and unchanged updates publish no workflow event.", inputSchema: z.toJSONSchema(todoInput, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
    async execute(input) {
      const { items } = todoInput.parse(input);
      // Stage synchronization and all updates before committing, so a rejected batch is atomic.
      const projected = { ...workflow.state, todos: workflow.state.todos };
      synchronizeWorkflowTodos(projected);
      const current = projected.todos!;
      const merged = new Map(current.map(item => [item.id, item]));
      const planItems = new Map(current.filter(item => item.stepId).map(item => [item.id, item]));
      for (const item of items ?? []) {
        const step = planItems.get(item.id);
        if (step) {
          if (item.text !== step.text || item.status !== step.status) return { isError: true, output: {
            code: "todo_plan_step_owned", stepId: step.stepId, expected: step,
            nextAction: "Use advance_workflow to update the plan text or start/reopen a step, and run_verification to obtain real passing receipts. Todo cannot change runtime-owned step progress.",
          } };
          continue;
        }
        merged.set(item.id, item);
      }
      const manualCount = [...merged.values()].filter(item => !item.stepId).length;
      if (manualCount > MANUAL_TODO_LIMIT || merged.size > WORKFLOW_TODO_LIMIT) return { isError: true, output: { code: "todo_limit", manualLimit: MANUAL_TODO_LIMIT, limit: WORKFLOW_TODO_LIMIT, count: merged.size, manualCount } };
      const next = [...merged.values()];
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      workflow.state.todos = next;
      if (changed) workflow.move(workflow.state.phase, "手动任务已更新；计划步骤进度由执行和验证结果同步");
      return { output: { items: workflow.state.todos, count: next.length, completed: next.filter(item => item.status === "completed").length,
        manualCount, changed, stepStatusSource: "Plan progress is runtime-owned: advance_workflow starts/reopens steps; real passing run_verification receipts mark them completed." } };
    },
  };
}
const requirementAcceptanceInput = z.object({ evidence: z.array(RequirementEvidenceSchema.extend({ passed: z.boolean() })).min(1).max(100) });
/** Acceptance can cite runtime evidence; it cannot create a test result or execute a reviewer. */
export function requirementAcceptanceTool(workflow: LightweightWorkflow): ToolDefinition {
  return {
    contract: { name: "check_requirements", description: "Submit evidence for every stable requirementId exactly once: passed=true, concrete summary and complete successful current observationIds. Read-only tasks can omit verificationIds and diffObservationId. Change tasks require current real passing local/integration verificationIds and a complete current diffObservationId; a runtime fingerprint matching the tests permits reusing an unchanged earlier diff. Model prose and todo status never create passing tests. Rejected explicit acceptance must be corrected before completion. This tool validates recorded evidence and does not run an independent model; then provide one final report.", inputSchema: z.toJSONSchema(requirementAcceptanceInput, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
    handlesInputValidation: true,
    async execute(input) {
      workflow.beginRequirementAcceptance();
      try {
        const { evidence } = requirementAcceptanceInput.parse(input);
        workflow.acceptRequirements(evidence);
        return { output: { accepted: true, requirementsRevision: workflow.state.requirementsRevision, requirementReceipts: workflow.state.requirementReceipts, nextAction: "Provide one final report using the accepted current evidence." } };
      } catch (error) {
        workflow.move("requirements_check", "需求验收尚未通过；修正所报字段或补充当前证据后继续，真实测试回执按实际影响保留");
        return { isError: true, output: {
          code: error instanceof z.ZodError ? "requirement_input_invalid" : "requirement_gate_rejected", error: error instanceof Error ? error.message : String(error),
          ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } : {}),
          requirementIds: workflow.state.requirementIds,
          availableObservationIds: workflow.state.observations.filter(item => !item.failed && item.complete && item.epoch === workflow.state.epoch && item.revision === workflow.state.revision).map(item => item.id),
          currentChecks: { local: workflow.state.localCheck, broader: workflow.state.broaderCheck },
          nextAction: error instanceof z.ZodError ? "Correct the reported input fields and retry check_requirements; input errors do not require new reads or test runs." : !workflow.needsChange ? "Cite complete successful evidence for the current repository scope and retry each named requirement; no test or diff is required for read-only acceptance." : !workflow.checksCurrent() ? "Repair code or improve tests without weakening valid assertions, then rerun required local and integration suites and retry acceptance." : "Cite complete current observations and actual passing runtime receipts, then retry acceptance. Reuse existing diff evidence when its runtime fingerprint matches the tests; refresh only missing, changed or truncated scope.",
        } };
      }
    },
  };
}
export const verificationInput = z.object({ command: z.string().trim().min(1).max(10000), cwd: z.string().default("."), timeoutMs: z.number().int().min(1).max(3600000).default(120000), stdin: z.string().max(1_000_000).optional(), stage: z.enum(["local", "broader"]).default("local"), dependencyPaths: z.array(z.string().trim().min(1).max(500)).max(100).optional(), force: z.boolean().default(false) });
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
