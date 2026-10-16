import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ToolGroupEntry, ToolTimelineItem } from "../conversation-stream.js";
import { OperationGroup } from "./OperationGroup.js";

const base = { runId: "run", at: "2026-10-15T00:00:00Z", sequence: 0 };

function command(id: string, value: string, state: "completed" | "error" | "pending" = "completed"): Extract<ToolGroupEntry, { kind: "tool" }> {
  const tool: ToolTimelineItem = {
    kind: "tool",
    started: { ...base, id, type: "tool_started", call: { id: `call-${id}`, name: "terminal", input: { command: value } } },
    ...(state === "pending" ? {} : {
      finished: { ...base, id: `${id}-finish`, sequence: 1, type: "tool_finished", callId: `call-${id}`, durationMs: 100, output: {}, ...(state === "error" ? { isError: true } : {}) },
    }),
  };
  return { kind: "tool", tool };
}

function edit(id: string): Extract<ToolGroupEntry, { kind: "tool" }> {
  return { kind: "tool", tool: { kind: "tool", started: { ...base, id, type: "tool_started", call: { id: `call-${id}`, name: "write_file", input: { path: "app.ts" } } } } };
}

it("describes a collapsed run in one sentence and leaves its rows unbuilt", () => {
  const serialize = vi.fn(() => { throw new Error("collapsed detail evaluated"); });
  const first = command("a", "pnpm test");
  first.tool.started.call.input = { command: "pnpm test", toJSON: serialize };
  const html = renderToStaticMarkup(<OperationGroup id="group" entries={[edit("edit"), first, command("b", "pnpm lint")]} active={false} />);
  expect(html).toContain('data-operation-group="group"');
  expect(html).toContain('data-slot="marker"');
  expect(html).toContain("编辑了文件，运行了命令");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("data-tool-call-id");
  expect(serialize).not.toHaveBeenCalled();
});

it("marks a failed run as an error and a live run as running", () => {
  const failed = renderToStaticMarkup(<OperationGroup id="failed" entries={[command("a", "pnpm test", "error"), command("b", "pnpm lint")]} active={false} />);
  expect(failed).toContain('data-operation-group-state="error"');
  expect(failed).toContain("lucide-circle-alert");
  expect(failed).toContain("运行了命令");

  const running = renderToStaticMarkup(<OperationGroup id="running" entries={[command("a", "pnpm test", "pending"), command("b", "pnpm lint")]} active />);
  expect(running).toContain('data-operation-group-state="running"');
  expect(running).toContain("lucide-loader-circle");
  expect(running).not.toContain("data-status");

  const stopped = renderToStaticMarkup(<OperationGroup id="stopped" entries={[command("a", "pnpm test", "pending"), command("b", "pnpm lint")]} active={false} />);
  expect(stopped).toContain('data-operation-group-state="interrupted"');
});
