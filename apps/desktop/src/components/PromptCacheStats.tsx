import React from "react";
import { summarizeCacheUsage, type Usage, type AgentEvent } from "@harness/protocol";

export function PromptCacheStats({ usages, events }: { usages: Usage[]; events?: AgentEvent[] }) {
  if (!usages.length) return null;
  const stats = summarizeCacheUsage(usages);
  const percentage = stats.hitRate === null ? null : (stats.hitRate * 100).toFixed(1);
  const main = summarizeCacheUsage(usages.filter(usage => (usage.purpose ?? "main") === "main"));
  const outcomes = events?.flatMap(event => event.type === "context_compacted" && event.record.summaryOutcome ? [event.record.summaryOutcome] : []) ?? [];
  const attempted = outcomes.filter(value => ["accepted", "truncated", "empty", "invalid_json", "provider_error", "target_fallback"].includes(value)).length;
  const accepted = outcomes.filter(value => value === "accepted").length;
  const adjustments = events?.flatMap(event => event.type === "context_adjusted" ? [event.adjustment] : []) ?? [];
  const count = (kind: string) => adjustments.filter(value => value.kind === kind).length;
  const compactions = events?.filter(event => event.type === "context_compacted").length ?? 0;
  return <section className="mb-3 rounded-xl border border-line px-4 py-3 text-xs text-text-muted" aria-label="输入缓存统计">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-text">主调用命中率 {main.hitRate === null ? "—" : (main.hitRate * 100).toFixed(1) + "%"}</strong>
      <span>总输入缓存命中率 {percentage === null ? "—" : percentage + "%"}</span>
      <span>总输入 {stats.inputTokens.toLocaleString()} tokens</span>
      <span>统计覆盖 {stats.measuredCalls}/{stats.totalCalls} 次请求</span>
    </div>
    {percentage === null ? <p className="mt-2">服务端未返回缓存数据，暂不计算命中率。</p> : <>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/20" role="meter" aria-label="缓存命中率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percentage)}><div className="h-full rounded-full bg-accent-text" style={{ width: percentage + "%" }} /></div>
      <p className="mt-2">已命中 {stats.cachedInputTokens.toLocaleString()} · 未命中 {(stats.measuredInputTokens - stats.cachedInputTokens).toLocaleString()} · 命中率 = 已命中 / 已返回缓存数据的输入 tokens</p>
    </>}
    {events && <p className="mt-2">{attempted ? `摘要采用 ${accepted}/${attempted}（${(accepted / attempted * 100).toFixed(1)}%）` : "摘要采用率不适用（无已记录模型摘要）"} · 历史裁剪 {count("tool_prune")} · 完整压缩 {compactions} · 首次结果限长 {count("tool_result_bound")} · 前缀重写 {events.filter(event => event.type === "cache_diagnostic" && event.diagnostic.reason === "rewrite").length}（仅有诊断的请求）</p>}
    {count("policy_migration") > 0 && <p className="mt-2">上下文配置已迁移：压缩目标低于触发阈值，原配置保存在 Profile 迁移记录中。</p>}
    <div className="mt-3 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">按请求用途分类的缓存和费用</caption><thead><tr><th>用途</th><th>输入 / 输出 tokens</th><th>缓存命中率</th><th>统计覆盖</th><th>费用</th></tr></thead><tbody>{(["main", "compaction", "review"] as const).map(purpose => {
      const group = usages.filter(usage => (usage.purpose ?? "main") === purpose);
      if (!group.length) return null;
      const summary = summarizeCacheUsage(group);
      const known = group.filter(usage => usage.costKnown === true || (usage.costKnown === undefined && usage.estimatedUsd > 0));
      const cost = known.reduce((total, usage) => total + usage.estimatedUsd, 0);
      return <tr key={purpose}><th className="pt-2 font-normal">{{ main: "主调用", compaction: "上下文压缩", review: "历史独立评审" }[purpose]}</th><td>{summary.inputTokens.toLocaleString()} / {group.reduce((total, usage) => total + usage.outputTokens, 0).toLocaleString()}</td><td>{summary.hitRate === null ? "未知" : (summary.hitRate * 100).toFixed(1) + "%"}</td><td>{summary.measuredCalls}/{summary.totalCalls}</td><td>{known.length === group.length ? "$" + cost.toFixed(4) : known.length ? "已知 $" + cost.toFixed(4) + "；部分费用未知" : "费用未知"}</td></tr>;
    })}</tbody></table></div>
  </section>;
}
