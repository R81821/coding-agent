import type { RunSpec, RunStopInfo, WorkflowState } from "@harness/protocol";

export class BudgetExceededError extends Error {
  constructor(readonly code: RunStopInfo["code"], message: string) { super(message); }
}

interface StopUsage { toolCalls: number; turns: number; repairAttemptsUsed: number; spentUsd: number; costKnown?: boolean; startedAt: number }
export function buildRunStop(code: RunStopInfo["code"], message: string, spec: RunSpec, usage: StopUsage, workflow?: WorkflowState, summaryError?: string): RunStopInfo {
  const pending: string[] = [];
  if (workflow && (workflow.intent === "change" || workflow.revision > 0)) {
    if (workflow.sequential) {
      if (!workflow.sequential.understanding) pending.push("需求理解");
      if (!workflow.sequential.architecture || workflow.sequential.architectureEpoch !== workflow.epoch) pending.push("仓库探索与架构识别");
      if (!workflow.sequential.steps.length) pending.push("分步实施计划");
      for (const step of workflow.sequential.steps) if (step.status !== "verified" || step.check.epoch !== workflow.epoch) pending.push(`步骤验证：${step.text}`);
    }
    if (workflow.diagnosisRequired) pending.push("诊断当前失败");
    if (workflow.localCheck.status !== "passed" || workflow.localCheck.revision !== workflow.revision || workflow.localCheck.epoch !== workflow.epoch) pending.push("局部验证");
    if (workflow.broaderCheck.revision !== workflow.revision || workflow.broaderCheck.epoch !== workflow.epoch || (workflow.broaderCheck.status !== "passed" && !(workflow.broaderPolicy !== "required" && workflow.broaderCheck.status === "skipped" && workflow.broaderCheck.reason))) pending.push(workflow.sequential ? "集成测试" : "扩大验证");
    if (workflow.diffRevision !== workflow.revision) pending.push("当前修改 diff 检查");
    if (workflow.requirementsRevision !== workflow.revision) pending.push("需求核对");
    if (workflow.reviewedRevision !== workflow.revision) pending.push("最终评审");
    if ((workflow.schemaVersion >= 3 || (workflow.reviewPolicy === "risk_based" && workflow.riskFlags.length)) && workflow.independentReview.status !== "passed") pending.push("独立评审");
  } else if (workflow) pending.push("分析结论与未检查范围");
  const lastFailure = workflow?.observations.findLast(item => item.failed && item.kind !== "verification");
  const failureMessage = lastFailure?.summary ?? workflow?.lastFailure;
  return {
    code, message, phase: workflow?.phase ?? "planning",
    usage: {
      toolCalls: { used: usage.toolCalls, limit: spec.budget.maxToolCalls },
      modelTurns: { used: usage.turns, limit: spec.budget.maxTurns },
      repairs: { used: usage.repairAttemptsUsed, limit: null },
      usd: { used: usage.spentUsd, limit: spec.budget.maxUsd, ...(usage.costKnown !== undefined ? { costKnown: usage.costKnown } : {}) },
      durationMs: { used: Math.max(0, Date.now() - usage.startedAt), limit: spec.budget.maxDurationMs },
    }, pending,
    ...(failureMessage ? { lastFailure: { message: failureMessage.slice(0, 1200), ...(lastFailure ? {tool: lastFailure.tool.slice(0, 120)} : {}) } } : {}),
    ...(summaryError ? { summaryError: summaryError.slice(0, 1200) } : {}),
  };
}
