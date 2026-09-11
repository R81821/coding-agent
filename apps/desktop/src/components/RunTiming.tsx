import React from "react";
import type { AgentEvent } from "@harness/protocol";

export function RunTiming({ events }: { events: AgentEvent[] }) {
  const unique = [...new Map(events.map(event => [event.id, event])).values()];
  const models = unique.filter((event): event is Extract<AgentEvent, { type: "model_request_finished" }> => event.type === "model_request_finished");
  const tools = unique.filter((event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished");
  if (!models.length && !tools.length) return null;
  const format = (durationMs: number) => (durationMs / 1000).toFixed(2) + " 秒";
  return <details className="mb-3 rounded-xl border border-line px-4 py-3 text-xs text-text-muted" aria-label="已记录耗时">
    <summary className="cursor-pointer">已记录耗时</summary>
    <ul className="mt-2 space-y-1">{(["main", "compaction", "review"] as const).map(purpose => {
      const group = models.filter(event => event.purpose === purpose);
      if (!group.length) return null;
      return <li key={purpose}>{{ main: "主模型请求", compaction: "压缩模型请求", review: "评审模型请求" }[purpose]}（含流式传输）：{format(group.reduce((sum, event) => sum + event.durationMs, 0))} · {group.length} 次 · {group.filter(event => !event.succeeded).length} 次失败</li>;
    })}{tools.length > 0 && <li>工具累计耗时：{format(tools.reduce((sum, event) => sum + event.durationMs, 0))} · {tools.length} 次</li>}</ul>
    <p className="mt-2">按已完成请求和工具分别累计，含失败尝试；并发及嵌套工具可能重叠，累计值不等于运行总时长。</p>
  </details>;
}
