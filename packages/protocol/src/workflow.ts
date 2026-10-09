import { z } from "zod";

export const WorkflowPhaseSchema = z.enum(["task_understanding", "repository_recon", "identify_architecture", "build_working_context", "plan_hypothesis", "small_edit", "local_verification", "inspect_result", "diagnose", "update_hypothesis", "broader_verification", "integration_test", "requirements_check", "final_review", "done"]);
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export const WORKFLOW_LABELS: Record<WorkflowPhase, string> = {
  task_understanding: "理解任务", repository_recon: "仓库探索", build_working_context: "构建工作上下文",
  identify_architecture: "识别架构", integration_test: "集成测试",
  plan_hypothesis: "计划与假设", small_edit: "局部修改", local_verification: "局部验证", inspect_result: "检查结果",
  diagnose: "失败诊断", update_hypothesis: "更新假设", broader_verification: "扩大验证",
  requirements_check: "核对需求", final_review: "最终评审", done: "完成",
};
export const CheckStateSchema = z.object({
  status: z.enum(["pending", "passed", "failed", "skipped"]), revision: z.number(), epoch: z.string(), runId: z.string().default(""), reason: z.string().default(""),
});
export const RequirementReceiptSchema = z.object({
  requirementId: z.string(), summary: z.string().min(1).max(3000), observationIds: z.array(z.string()).min(1).max(12),
  verificationIds: z.array(z.string()).min(1).max(12), diffObservationId: z.string(),
});
const pendingCheck = { status: "pending" as const, revision: -1, epoch: "legacy", runId: "", reason: "" };
export const StepVerificationSchema = z.object({
  command: z.string().trim().min(1).max(10000), cwd: z.string().default("."),
  timeoutMs: z.number().int().min(1).max(3600000).default(120000), stdin: z.string().max(1_000_000).optional(),
});
export const SequentialPlanStepSchema = z.object({
  id: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(1000),
  verification: z.array(StepVerificationSchema).min(1).max(8),
});
export const SequentialWorkflowSchema = z.object({
  understanding: z.string().default(""), understoodAt: z.number().default(0),
  architecture: z.string().default(""), architectureEpoch: z.string().default(""),
  evidenceIds: z.array(z.string()).default([]), generation: z.number().int().nonnegative().default(0),
  patchRecovery: z.object({
    callId: z.string(), kind: z.enum(["format", "conflict"]), paths: z.array(z.string()).max(20),
    contextReadRequired: z.boolean(),
  }).optional(),
  activeStepId: z.string().default(""),
  steps: z.array(SequentialPlanStepSchema.extend({
    status: z.enum(["pending", "in_progress", "verified"]).default("pending"),
    check: CheckStateSchema.default(pendingCheck),
  })).max(20).default([]),
  integration: z.array(StepVerificationSchema).max(8).default([]),
});
export const WorkflowStateSchema = z.object({
  sequential: SequentialWorkflowSchema.optional(),
  taskMode: z.enum(["auto", "analysis", "change"]).optional(),
  effect: z.enum(["read", "probe", "repository_write", "unknown"]).optional(),
  todos: z.array(z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(300), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) })).max(20).optional(),
  schemaVersion: z.number().default(2), epoch: z.string().default("legacy"), observationSequence: z.number().default(0),
  activity: z.string().default(""), requirementIds: z.array(z.string()).default([]),
  requirementReceipts: z.array(RequirementReceiptSchema).default([]), reviewEvidenceIds: z.array(z.string()).default([]),
  broaderPolicy: z.enum(["required", "optional", "disabled"]).default("optional"),
  reviewPolicy: z.enum(["standard", "risk_based"]).default("standard"),
  localCheck: CheckStateSchema.default(pendingCheck), broaderCheck: CheckStateSchema.default(pendingCheck),
  independentReview: CheckStateSchema.default(pendingCheck), riskFlags: z.array(z.string()).default([]),
  activeFailureId: z.string().default(""), activeChainId: z.string().default(""),
  failureChains: z.array(z.object({ id: z.string(), source: z.string(), fingerprint: z.string(), count: z.number(), status: z.enum(["open", "resolved"]), lastSequence: z.number(), lastRevision: z.number(), epoch: z.string(), failureId: z.string() })).default([]),
  phase: WorkflowPhaseSchema,
  objective: z.string(),
  intent: z.enum(["analysis", "change"]).optional(),
  requirements: z.array(z.string()),
  context: z.string(),
  plan: z.array(z.string()),
  hypotheses: z.array(z.object({ alternatives: z.array(z.string()).optional(), experiment: z.object({ question: z.string(), expectedResults: z.array(z.string()), observationIds: z.array(z.string()) }).optional(), cause: z.string(), evidenceIds: z.array(z.string()), revision: z.number() })),
  verification: z.array(z.object({ stage: z.enum(["local", "broader"]), command: z.string(), cwd: z.string(), timeoutMs: z.number(), stdin: z.string().optional() })).default([]),
  observations: z.array(z.object({ complete: z.boolean().default(true), sequence: z.number().default(0), epoch: z.string().default("legacy"), failureId: z.string().default(""), digest: z.string().default(""), kind: z.enum(["tool", "verification", "failure"]).default("tool"), id: z.string(), tool: z.string(), target: z.string(), summary: z.string(), failed: z.boolean(), revision: z.number() })),
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
