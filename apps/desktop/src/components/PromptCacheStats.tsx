import React from "react";
import { summarizeCacheUsage, type Usage } from "@harness/protocol";

export function PromptCacheStats({ usages }: { usages: Usage[] }) {
  if (!usages.length) return null;
  const stats = summarizeCacheUsage(usages);
  const percentage = stats.hitRate === null ? null : (stats.hitRate * 100).toFixed(1);
  return <section className="mb-3 rounded-xl border border-line px-4 py-3 text-xs text-text-muted" aria-label="输入缓存统计">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-text">输入缓存命中率 {percentage === null ? "—" : percentage + "%"}</strong>
      <span>总输入 {stats.inputTokens.toLocaleString()} tokens</span>
      <span>统计覆盖 {stats.measuredCalls}/{stats.totalCalls} 次请求</span>
    </div>
    {percentage === null ? <p className="mt-2">服务端未返回缓存数据，暂不计算命中率。</p> : <>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/20" role="meter" aria-label="缓存命中率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percentage)}><div className="h-full rounded-full bg-accent-text" style={{ width: percentage + "%" }} /></div>
      <p className="mt-2">已命中 {stats.cachedInputTokens.toLocaleString()} · 未命中 {(stats.measuredInputTokens - stats.cachedInputTokens).toLocaleString()} · 命中率 = 已命中 / 已返回缓存数据的输入 tokens</p>
    </>}
  </section>;
}
