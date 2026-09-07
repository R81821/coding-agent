import { z } from "zod";

export const WorkflowPhaseSchema = z.enum(["task_understanding", "repository_recon", "build_working_context", "plan_hypothesis", "small_edit", "local_verification", "inspect_result", "diagnose", "update_hypothesis", "broader_verification", "requirements_check", "final_review", "done"]);
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export const WORKFLOW_LABELS: Record<WorkflowPhase, string> = {
  task_understanding: "理解任务", repository_recon: "仓库探索", build_working_context: "构建工作上下文",
  plan_hypothesis: "计划与假设", small_edit: "局部修改", local_verification: "局部验证", inspect_result: "检查结果",
  diagnose: "失败诊断", update_hypothesis: "更新假设", broader_verification: "扩大验证",
  requirements_check: "核对需求", final_review: "最终评审", done: "完成",
};
export const WorkflowStateSchema = z.object({
  phase: WorkflowPhaseSchema,
  objective: z.string(),
  intent: z.enum(["analysis", "change"]).optional(),
  requirements: z.array(z.string()),
  context: z.string(),
  plan: z.array(z.string()),
  hypotheses: z.array(z.object({ cause: z.string(), evidenceIds: z.array(z.string()), revision: z.number() })),
  verification: z.array(z.object({ stage: z.enum(["local", "broader"]), command: z.string(), cwd: z.string(), timeoutMs: z.number() })).default([]),
  observations: z.array(z.object({ id: z.string(), tool: z.string(), target: z.string(), summary: z.string(), failed: z.boolean(), revision: z.number() })),
  relevantFiles: z.array(z.string()),
  changedFiles: z.array(z.string()),
  revision: z.number(),
  localRevision: z.number(),
  broaderRevision: z.number(),
  diffRevision: z.number(),
  requirementsRevision: z.number(),
  reviewedRevision: z.number(),
  failures: z.number(),
  diagnosisRequired: z.boolean(),
  lastFailure: z.string(),
  requirementEvidence: z.array(z.string()),
  review: z.string(),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;