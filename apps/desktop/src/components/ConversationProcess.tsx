import React, { useEffect } from "react";
import { useRowState } from "@harness/conversation-ui";
import type { AgentEvent } from "@harness/protocol";

export function conversationDurationMs(events: AgentEvent[]): number {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const timed: Array<{ event: AgentEvent; timestamp: number }> = [];
  for (const event of events) {
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < first) first = timestamp;
    if (timestamp > last) last = timestamp;
    timed.push({ event, timestamp });
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  timed.sort((a, b) => a.timestamp - b.timestamp);
  let pausedAt: number | undefined;
  let pausedMs = 0;
  for (const { event, timestamp } of timed) {
    if (
      (event.type === "status" || event.type === "result") &&
      event.status === "paused"
    ) {
      pausedAt ??= timestamp;
    } else if (
      event.type === "status" &&
      pausedAt !== undefined &&
      ["planning", "running", "verifying", "review"].includes(event.status)
    ) {
      pausedMs += Math.max(0, timestamp - pausedAt);
      pausedAt = undefined;
    }
  }
  if (pausedAt !== undefined) pausedMs += Math.max(0, last - pausedAt);
  return Math.max(0, last - first - pausedMs);
}

export function formatConversationDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `用时 ${minutes}分${seconds ? `${seconds}秒` : ""}`;
  return `用时 ${seconds}秒`;
}

export function terminalConversationStatus(
  events: AgentEvent[],
): "completed" | "review" | "failed" | "cancelled" | undefined {
  const result = events.findLast((event) => event.type === "result");
  // A review result ends this turn too, even though the task still has unresolved work.
  return result?.type === "result" &&
    ["completed", "review", "failed", "cancelled"].includes(result.status)
    ? (result.status as "completed" | "review" | "failed" | "cancelled")
    : undefined;
}

export function ConversationProcessSummary({
  completed,
  durationMs,
  activeLabel = "运行中",
  preview = false,
  children,
}: {
  completed: boolean;
  durationMs: number;
  activeLabel?: string;
  preview?: boolean;
  children: React.ReactNode | (() => React.ReactNode);
}) {
  const [open, setOpen] = useRowState("processOpen", !completed);
  const [lastCompleted, setLastCompleted] = useRowState("processCompleted", completed);

  useEffect(() => {
    if (lastCompleted !== completed) { setOpen(!completed); setLastCompleted(completed); }
  }, [completed, lastCompleted, setOpen, setLastCompleted]);

  return (
    <details
      className="conversation-process"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="conversation-process-summary">
        <span>
          {completed ? preview ? "执行过程" : formatConversationDuration(durationMs) : activeLabel}
        </span>
      </summary>
      {open && <div className="conversation-process-body">{typeof children === "function" ? children() : children}</div>}
    </details>
  );
}
