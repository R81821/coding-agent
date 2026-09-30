import type {
  AgentEvent,
  PluginRecord,
  RunStatus,
  SessionDetail,
} from "@harness/protocol";

export const statusLabels: Record<RunStatus, string> = {
  queued: "等待中",
  planning: "规划中",
  running: "运行中",
  verifying: "验证中",
  waiting_approval: "待审批",
  review: "审查中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export const isActive = (status?: RunStatus) =>
  !!status &&
  [
    "queued",
    "planning",
    "running",
    "verifying",
    "waiting_approval",
    "review",
  ].includes(status);
export const projectName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
export type Turn = SessionDetail["runs"][number];
export type Skill = {
  key: string;
  manifest: { name: string; description: string; trustedHash?: string };
  scope?: string;
  changedSinceTrust?: boolean;
};
export type Plugin = PluginRecord;

// The final result replaces streamed text, so a completed answer is never duplicated.
export function answerText(events: AgentEvent[]) {
  const final = events.findLast((event) => event.type === "result");
  if (final?.type === "result" && final.text.trim()) return final.text;
  let text = "";
  for (const event of events) {
    if (event.type === "assistant_turn_started" && text) text += "\n\n";
    if (event.type === "text_delta") text += event.delta;
  }
  return text;
}
export function activityText(event: AgentEvent): string | undefined {
  if (event.type === "tool_started") return `调用 ${event.call.name}`;
  if (event.type === "tool_finished")
    return `${event.isError ? "工具执行失败" : "工具执行完成"} · ${event.durationMs} ms`;
  if (event.type === "reasoning_summary") return event.summary;
  if (event.type === "error") return event.message;
  if (event.type === "route") return `${event.providerId} / ${event.modelId}`;
  if (event.type === "status") return statusLabels[event.status];
  if (event.type === "workflow_updated") return event.detail;
  return undefined;
}
