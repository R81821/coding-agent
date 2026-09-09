import React from "react";
import type { RunStopInfo } from "@harness/protocol";
import { WORKFLOW_LABELS } from "@harness/protocol";

export function RunStopCard({ stop }: { stop?: RunStopInfo }) {
  if (!stop) return null;
  const { usage } = stop;
  const phase = Object.hasOwn(WORKFLOW_LABELS, stop.phase)
    ? WORKFLOW_LABELS[stop.phase as keyof typeof WORKFLOW_LABELS]
    : stop.phase;
  return (
    <section className="glass mb-3 space-y-2 border-warning/30 px-4 py-3" aria-label="运行停止原因">
      <h3 className="break-words text-sm font-semibold text-warning">未完成：{stop.message}</h3>
      <p className="text-xs text-text">{`工具 ${usage.toolCalls.used}/${usage.toolCalls.limit} · 模型 ${usage.modelTurns.used}/${usage.modelTurns.limit} · 修复 ${usage.repairs.used} 次／不限`}</p>
      <p className="text-xs text-text-muted">{`费用 $${usage.usd.used.toFixed(2)}/$${usage.usd.limit.toFixed(2)} · 耗时 ${(usage.durationMs.used / 60000).toFixed(1)}/${(usage.durationMs.limit / 60000).toFixed(1)} 分钟`}</p>
      <p className="text-xs text-text-muted">当前阶段：{phase}</p>
      {stop.lastFailure && <p className="break-words text-xs text-text">最近失败：{stop.lastFailure.tool && `${stop.lastFailure.tool} · `}{stop.lastFailure.message}</p>}
      {stop.pending.length > 0 && <p className="break-words text-xs text-text">待完成：{stop.pending.join("、")}</p>}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">查看停止详情</summary>
        <p className="mt-2 break-words">原因代码：{stop.code} · 阶段：{stop.phase}</p>
        {stop.summaryError && <p className="mt-2 break-words">总结未生成：{stop.summaryError}</p>}
      </details>
    </section>
  );
}