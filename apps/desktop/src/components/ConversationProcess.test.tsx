import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationProcessSummary, conversationDurationMs, formatConversationDuration } from "./ConversationProcess.js";
import type { AgentEvent } from "@harness/protocol";

it("formats elapsed time in the compact Chinese summary", () => {
  expect(formatConversationDuration(237_000)).toBe("用时 3分57秒");
  expect(formatConversationDuration(12_000)).toBe("用时 12秒");
});

it("collapses completed process content and keeps active content open", () => {
  const completed = renderToStaticMarkup(
    <ConversationProcessSummary completed durationMs={237_000}>
      <div>工具过程</div>
    </ConversationProcessSummary>,
  );
  const active = renderToStaticMarkup(
    <ConversationProcessSummary completed={false} durationMs={0}>
      <div>工具过程</div>
    </ConversationProcessSummary>,
  );

  expect(completed).toContain("用时 3分57秒");
  expect(completed).not.toContain("open=\"\"");
  expect(active).toContain("运行中");
  expect(active).toContain("open=\"\"");
});

it("measures the wall-clock duration from the first to the last event", () => {
  const base = { runId: "run", sequence: 0 };
  const events: AgentEvent[] = [
    { ...base, id: "first", at: "2026-09-22T10:00:00.000Z", type: "assistant_turn_started" },
    { ...base, id: "last", at: "2026-09-22T10:03:57.000Z", sequence: 1, type: "result", text: "完成", status: "completed" },
  ];
  expect(conversationDurationMs(events)).toBe(237_000);
});
