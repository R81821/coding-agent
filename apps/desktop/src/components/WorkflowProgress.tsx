import React from "react";
import { WORKFLOW_LABELS, type AgentEvent } from "@harness/protocol";

export function WorkflowProgress({ events }: { events: AgentEvent[] }) {
  const stages = events.filter((event): event is Extract<AgentEvent, { type: "workflow_updated" }> => event.type === "workflow_updated");
  const latest = stages.at(-1);
  if (!latest) return null;
  const state = latest.workflow;
  const modern = state.taskMode !== undefined;
  const change = state.revision > 0 || state.intent === "change" || state.effect === "repository_write" || state.taskMode === "change";
  const requirementsAccepted = state.requirements.length > 0 && state.requirementsRevision === state.revision && state.requirements.every((_item, index) => state.requirementReceipts.some(receipt => receipt.requirementId === state.requirementIds[index]));
  const phaseLabel = (phase: typeof state.phase) => modern && phase === "final_review" ? "最终验收" : WORKFLOW_LABELS[phase];
  const todoLabels = { pending: "待办", in_progress: "进行中", completed: "已完成", cancelled: "已取消" };
  const stepLabels = { pending: "待开始", in_progress: "实施／验证中", verified: "验证通过" };
  const chain = state.failureChains?.find(item => item.id === state.activeChainId && item.status === "open");
  const checkLabels = { pending: "待验证", passed: "通过", failed: "失败", skipped: "已跳过" };
  const verificationLabel = (key: "localCheck" | "broaderCheck") => {
    const check = state[key];
    if (modern && !change && !check?.runId) return "无需代码验证";
    if (!check) return "历史记录，未区分验证与跳过";
    if (check.status === "passed" && (check.epoch !== state.epoch || check.revision !== state.revision)) return "待重新验证";
    if (check.status === "failed") return "失败，待修复重测";
    return checkLabels[check.status];
  };
  return <details className="glass mb-3 px-4 py-3 workflow-progress">
    <summary className="cursor-pointer text-sm text-text"><strong>{phaseLabel(state.phase)}</strong><span className="ml-3 text-xs text-text-muted">{modern && !change ? "分析任务" : `修改版本 ${state.revision}`} · 累计失败 {state.failures} · 当前故障重复 {chain?.count ?? 0} 次</span></summary>
    <p className="mt-2 text-xs text-text-muted">{latest.detail}</p>
    {state.activity && <p className="mt-2 break-words text-xs text-text-muted">工具活动：{state.activity}</p>}
    <div className="mt-3 space-y-1 text-xs text-text workflow-checks">{(["localCheck", "broaderCheck"] as const).map((key, index) => <p key={key}>{index === 0 ? "局部验证" : state.sequential && change ? "集成测试" : "扩大验证"}：{verificationLabel(key)}{state[key]?.reason && <span className="ml-2 text-text-muted">{state[key].reason}</span>}</p>)}
    <p>逐项需求验收：{modern && !change ? "无需修改验收" : requirementsAccepted ? "通过" : "待验收"}</p>
    {state.independentReview?.runId && <p>历史独立评审：{checkLabels[state.independentReview.status]}</p>}</div>
    {change && <p className="mt-2 text-xs text-text-muted">测试失败后修复并重跑；证据过期后更新测试、diff 和需求验收，继续直到通过。</p>}
    {state.sequential && change && <section aria-label="分步实施流程" className="mt-3 space-y-1 text-xs text-text">
      <p>需求理解：{state.sequential.understanding || "待记录"}</p>
      <p>架构识别：{state.sequential.architecture || "待探索"}{state.sequential.architecture && state.sequential.architectureEpoch !== state.epoch ? "（恢复后待重新核对）" : ""}</p>
      <ol aria-label="实施步骤">{state.sequential.steps.map((step, index) => <li key={step.id}>{index + 1}. {step.text} · {stepLabels[step.status]}{step.check.runId && ` · ${checkLabels[step.check.status]}`}</li>)}</ol>
    </section>}
    {state.todos && state.todos.length > 0 && <ul aria-label="任务待办" className="mt-3 space-y-1 text-xs text-text">{state.todos.map(todo => <li key={todo.id}>{todoLabels[todo.status]}：{todo.text}</li>)}</ul>}
    {state.changedFiles.length > 0 && <div className="mt-3 text-xs text-text"><strong>实际变更文件</strong><ul aria-label="实际变更文件">{state.changedFiles.map(path => <li key={path} className="break-all">{path}</li>)}</ul></div>}
    <ol className="mt-3 space-y-1 text-xs text-text-muted">{stages.slice(-16).map(event => <li key={event.id}>{phaseLabel(event.workflow.phase)}：{event.detail}</li>)}</ol>
    {state.hypotheses.length > 0 && <p className="mt-3 text-xs text-text">当前假设：{state.hypotheses.at(-1)?.cause}</p>}
    {state.requirementReceipts?.length > 0 && <p className="mt-2 text-xs text-text-muted">{requirementsAccepted ? "需求证据核对已完成。" : "需求证据需按当前版本重新验收。"}</p>}
    {state.requirements.length > 0 && <ul className="mt-2 space-y-1 text-xs text-text">{state.requirements.map((item, index) => <li key={index}>{requirementsAccepted && state.requirementReceipts.some(receipt => receipt.requirementId === state.requirementIds[index]) ? "✓" : "○"} {item}</li>)}</ul>}
  </details>;
}

