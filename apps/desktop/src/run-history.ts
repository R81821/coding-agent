import type { AgentEvent, RunHistoryPage, RunStatus } from "@harness/protocol";

export function mergeRunHistory(current: RunHistoryPage, incoming: RunHistoryPage, append: boolean): RunHistoryPage {
  const records = new Map(current.items.map((item) => [item.id, item]));
  for (const item of incoming.items) records.set(item.id, item);
  const items = [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { items, hasMore: append || current.items.length <= incoming.items.length ? incoming.hasMore : current.hasMore };
}

export function mergeRunEvents(current: AgentEvent[], incoming: AgentEvent[], runId: string): AgentEvent[] {
  const events = new Map<number, AgentEvent>();
  for (const event of [...current, ...incoming]) if (event.runId === runId) events.set(event.sequence, event);
  return [...events.values()].sort((a, b) => a.sequence - b.sequence);
}

export function isLiveRun(status: RunStatus): boolean {
  return ["queued", "planning", "running", "waiting_approval", "verifying"].includes(status);
}

export const runStatusLabel: Record<RunStatus, string> = {
  queued: "排队中", planning: "规划中", running: "运行中", waiting_approval: "待审批",
  verifying: "验证中", paused: "已暂停", review: "待复核", completed: "已完成", failed: "失败", cancelled: "已取消",
};
