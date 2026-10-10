import type { RunSpec, RunStopInfo, WorkflowState } from "@harness/protocol";
import { activeElapsedMs } from "./durable-recovery.js";

export class BudgetExceededError extends Error {
  constructor(readonly code: RunStopInfo["code"], message: string) { super(message); }
}

interface StopUsage { toolCalls: number; turns: number; repairAttemptsUsed: number; spentUsd: number; costKnown?: boolean; startedAt: number; elapsedBeforeStartMs?: number }

/** Outstanding work at a stop or pause boundary, shared by the stop receipt and the pause notice. */
export function pendingWork(workflow?: WorkflowState): string[] {
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
    if (workflow.requirementsRevision !== workflow.revision) pending.push("逐项需求验收");
    if (workflow.reviewedRevision !== workflow.revision) pending.push("当前版本的最终报告");
  } else if (workflow) pending.push("分析结论与未检查范围");
  return pending;
}

/** Explain the gate that remains when a real request/tool budget is exhausted. */
export function budgetStopMessage(code: "model_turn_limit" | "tool_call_limit", workflow: WorkflowState, hasCurrentReport: boolean): string {
  const limit = code === "model_turn_limit" ? "模型轮次额度已用完" : "工具调用额度已用完";
  const pending = pendingWork(workflow);
  if (!hasCurrentReport && !pending.includes("分析结论与未检查范围")) pending.push("当前版本的完整报告");
  return `${limit}${pending.length ? `；尚未完成：${pending.join("、")}` : "；完成条件尚未满足"}`;
}

export function buildRunStop(code: RunStopInfo["code"], message: string, spec: RunSpec, usage: StopUsage, workflow?: WorkflowState, summaryError?: string): RunStopInfo {
  const pending = pendingWork(workflow);
  const lastFailure = workflow?.observations.findLast(item => item.failed && item.kind !== "verification");
  const failureMessage = lastFailure?.summary ?? workflow?.lastFailure;
  return {
    code, message, phase: workflow?.phase ?? "planning",
    usage: {
      toolCalls: { used: usage.toolCalls, limit: spec.budget.maxToolCalls },
      modelTurns: { used: usage.turns, limit: spec.budget.maxTurns },
      repairs: { used: usage.repairAttemptsUsed, limit: null },
      usd: { used: usage.spentUsd, limit: spec.budget.maxUsd, ...(usage.costKnown !== undefined ? { costKnown: usage.costKnown } : {}) },
      durationMs: { used: Math.floor(activeElapsedMs(usage)), limit: spec.budget.maxDurationMs },
    }, pending,
    ...(failureMessage ? { lastFailure: { message: failureMessage.slice(0, 1200), ...(lastFailure ? {tool: lastFailure.tool.slice(0, 120)} : {}) } } : {}),
    ...(summaryError ? { summaryError: summaryError.slice(0, 1200) } : {}),
  };
}
