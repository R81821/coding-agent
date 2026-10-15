import React from "react";
import { latestContextUsage, summarizeCacheUsage, type Usage, type AgentEvent, type ContextUsage } from "@harness/protocol";
import "./prompt-cache-stats.css";

export function PromptCacheStats({ usages, events, contextEvents, contextUsage, eventsComplete = true }: { usages: Usage[]; events?: AgentEvent[]; contextEvents?: AgentEvent[]; contextUsage?: ContextUsage | null; eventsComplete?: boolean }) {
  const context = contextUsage === undefined ? latestContextUsage(contextEvents ?? events ?? []) : contextUsage;
  const compactions = events?.filter(event => event.type === "context_compacted").length ?? 0;
  const hasRecordedContext = events?.some(event => event.type === "context_usage" || event.type === "context_adjusted" && event.adjustment.capacityTokens !== undefined);
  if (!usages.length && !context && !compactions && !hasRecordedContext) return null;

  const stats = summarizeCacheUsage(usages);
  const cachePercentage = !eventsComplete || stats.hitRate === null ? "—" : (stats.hitRate * 100).toFixed(1) + "%";
  const outputTokens = usages.reduce((total, usage) => total + usage.outputTokens, 0);
  const occupancy = context && Number.isFinite(context.usedTokens) && context.usedTokens >= 0
    && Number.isFinite(context.capacityTokens) && context.capacityTokens > 0
    ? context.usedTokens / context.capacityTokens * 100
    : null;
  const contextPercentage = occupancy === null ? "—" : Math.round(occupancy) + "%";
  const meterValue = occupancy === null ? undefined : Math.min(100, occupancy);
  const contextDescription = occupancy === null || !context ? "上下文占用未知"
    : `${context.source === "estimate" ? "估算 " : ""}${context.usedTokens.toLocaleString()} / ${context.capacityTokens.toLocaleString()} tokens`;
  const contextLevel = occupancy === null ? "unknown" : occupancy >= 95 ? "critical" : occupancy >= 80 ? "high" : "normal";

  return <section className="prompt-cache-stats" aria-label="输入缓存统计">
    <div className="prompt-cache-metrics flex-nowrap whitespace-nowrap" data-testid="token-metrics">
      <span>总输入缓存命中率 <strong>{cachePercentage}</strong></span>
      <span>总输入 token <strong>{eventsComplete ? stats.inputTokens.toLocaleString() : "—"}</strong></span>
      <span>总输出 token <strong>{eventsComplete ? outputTokens.toLocaleString() : "—"}</strong></span>
      <span>压缩次数 <strong>{eventsComplete ? compactions : "—"}</strong></span>
    </div>
    <div className="prompt-context-usage" data-level={contextLevel} title={contextDescription}>
      <span className="prompt-context-label">上下文</span>
      <div className="prompt-context-meter" role="meter" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meterValue} aria-valuetext={occupancy === null ? contextDescription : contextPercentage}>
        <div className="prompt-context-fill" style={{ width: `${meterValue ?? 0}%` }} />
      </div>
      <span className="prompt-context-percentage">{contextPercentage}</span>
    </div>
  </section>;
}
