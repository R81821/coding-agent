import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ToolTimelineItem } from "../conversation-stream.js";
import { ApprovalTraceRow, ProcessTraceRow, ReasoningTraceRow, ThinkingTraceRow, ToolTraceRow } from "./ConversationTrace.js";

const base = { id: "event", runId: "run", at: "2026-10-15T00:00:00Z", sequence: 0 };
const tool: ToolTimelineItem = {
  kind: "tool",
  started: { ...base, type: "tool_started", call: { id: "call", name: "terminal", input: { command: "pnpm test" } } },
};

it("does not serialize collapsed tool input or output while transcript deltas arrive", () => {
  const serialize = vi.fn(() => { throw new Error("collapsed detail evaluated"); });
  const html = renderToStaticMarkup(<ToolTraceRow active={false} tool={{
    ...tool,
    started: { ...tool.started, call: { ...tool.started.call, input: { command: "pnpm test", toJSON: serialize } } },
    finished: { ...base, id: "finish", sequence: 1, type: "tool_finished", callId: "call", durationMs: 100, output: { toJSON: serialize } },
  }} />);
  expect(serialize).not.toHaveBeenCalled();
  expect(html).toContain("已运行 pnpm test");
  expect(html).toContain('aria-expanded="false"');
});

it("distinguishes a running tool from one interrupted by a stopped run", () => {
  const running = renderToStaticMarkup(<ToolTraceRow active tool={tool} />);
  const stopped = renderToStaticMarkup(<ToolTraceRow active={false} tool={tool} />);
  expect(running).toContain('data-status="running"');
  expect(running).toContain("正在执行 pnpm test");
  expect(stopped).toContain("执行已中断 pnpm test");
  expect(stopped).not.toContain('data-status="running"');
});

it("retains the failed command's state while keeping command metadata in its lazy detail", () => {
  const html = renderToStaticMarkup(<ToolTraceRow active={false} tool={{ ...tool, finished: {
    ...base, id: "finish", sequence: 1, type: "tool_finished", callId: "call", durationMs: 1200, isError: true, output: "failed",
  } }} />);
  expect(html).toContain('data-status="error"');
  expect(html).toContain('data-tool-state="error"');
  expect(html).toContain('data-conversation-terminal="true"');
  expect(html).toContain("执行失败 pnpm test");
  expect(html).not.toContain("1.2 秒");
});

it.each([true, false])("summarizes probe commands with the recorded result state error=%s and keeps stdin collapsed", isError => {
  const html = renderToStaticMarkup(<ToolTraceRow active={false} tool={{
    ...tool,
    started: { ...tool.started, call: { id: "probe-call", name: "probe", input: { command: "python -", stdin: "PROBE_STDIN_BODY" } } },
    finished: { ...base, id: "probe-finish", sequence: 1, type: "tool_finished", callId: "probe-call", durationMs: 4400,
      isError, output: { evidenceId: "probe-call", result: `{"exitCode":${isError ? 1 : 0}}\nprobe result`, isError } },
  }} />);
  expect(html).toContain('data-tool-name="probe"');
  expect(html).toContain('data-conversation-terminal="true"');
  expect(html).toContain(`data-tool-state="${isError ? "error" : "completed"}"`);
  expect(html).toContain(`${isError ? "执行失败" : "已运行"} probe · python -`);
  expect(html).not.toContain("PROBE_STDIN_BODY");
  expect(html).not.toContain("4.4 秒");
});

it("keeps approval records compact without implying that a request has been approved", () => {
  const summary = `probe (high): ${JSON.stringify({ command: "python -", stdin: "PROBE_STDIN_BODY\n".repeat(200) }).slice(0, 2000)}`;
  const html = renderToStaticMarkup(<ApprovalTraceRow event={{ ...base, type: "approval_required", approvalId: "approval-probe", risk: "high", summary }} />);
  expect(html).toContain('data-conversation-approval="approval-probe"');
  expect(html).toContain('data-approval-risk="high"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("审批请求 probe · python -");
  expect(html).toContain("高风险");
  expect(html).not.toContain("PROBE_STDIN_BODY");
  expect(html).not.toContain("已批准");
  expect(html).not.toContain("lucide-circle-check");
});

it("labels available reasoning as a summary without inventing thinking duration", () => {
  const html = renderToStaticMarkup(<ReasoningTraceRow id="reason" text="Check the lockfile" />);
  expect(html).toContain("思考摘要");
  expect(html).not.toContain("5s");
});

it("expands a live reasoning summary and renders its Markdown", () => {
  const html = renderToStaticMarkup(<ReasoningTraceRow id="reason" text="**检查依赖**\n\n确认锁文件。" running />);
  expect(html).toContain('data-conversation-reasoning="true"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("正在思考");
  expect(html).toContain("<strong>检查依赖</strong>");
  expect(html).toContain("确认锁文件。");
});

it.each([true, false])("keeps process dialogue directly visible while streaming=%s", live => {
  const html = renderToStaticMarkup(<ProcessTraceRow id="process" text="先检查 **依赖**。\n\n再运行 `pnpm test`。" live={live} />);
  expect(html).toContain('data-conversation-process-message="process"');
  expect(html).toContain(`data-streaming="${live}"`);
  expect(html).toContain("<strong>依赖</strong>");
  expect(html).toContain("<code>pnpm test</code>");
  expect(html).not.toContain("aria-expanded");
  expect(html).not.toContain("trace-collapsible-trigger");
});

it("keeps the thinking module present when a model provides no public summary", () => {
  const html = renderToStaticMarkup(<ThinkingTraceRow id="segment" running={false} active={false} />);
  expect(html).toContain('data-conversation-reasoning="true"');
  expect(html).toContain('data-summary-available="false"');
  expect(html).toContain("未返回摘要");
  expect(html).not.toContain('data-status="running"');
});
