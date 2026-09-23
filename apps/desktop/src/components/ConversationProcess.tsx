import React, { useEffect, useState } from "react";
import type { AgentEvent } from "@harness/protocol";

export function conversationDurationMs(events: AgentEvent[]): number {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < first) first = timestamp;
    if (timestamp > last) last = timestamp;
  }
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0;
}

export function formatConversationDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `用时 ${minutes}分${seconds ? `${seconds}秒` : ""}`;
  return `用时 ${seconds}秒`;
}

export function ConversationProcessSummary({
  completed,
  durationMs,
  children,
}: {
  completed: boolean;
  durationMs: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!completed);

  useEffect(() => {
    setOpen(!completed);
  }, [completed]);

  return (
    <details
      className="conversation-process"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="conversation-process-summary">
        <span>{completed ? formatConversationDuration(durationMs) : "运行中"}</span>
      </summary>
      <div className="conversation-process-body">{children}</div>
    </details>
  );
}
