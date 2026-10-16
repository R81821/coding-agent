import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ToolGroupEntry, ToolTimelineItem } from "../conversation-stream.js";
import { ReadToolGroup, ToolTraceList } from "./ReadToolGroup.js";

function read(id: string, path: string, extra: Record<string, unknown> = {}): ToolTimelineItem {
  const base = { runId: "run", at: "2026-10-15T00:00:00Z", sequence: 0 };
  return {
    kind: "tool",
    started: { ...base, id, type: "tool_started", call: { id, name: "read_file", input: { path, ...extra } } },
    finished: { ...base, id: `${id}-finished`, type: "tool_finished", callId: id, durationMs: 100, output: { content: "private file content" } },
  };
}

const entriesOf = (...tools: ToolTimelineItem[]): ToolGroupEntry[] => tools.map(tool => ({ kind: "tool", tool }));

it("compresses repeated reads into one accessible marker without constructing individual details", () => {
  const serialize = vi.fn(() => { throw new Error("collapsed output evaluated"); });
  const tools = [read("a", "src/app.ts"), read("b", "src/theme.ts"), read("c", "src/theme.ts", { offset: 40, limit: 20 })];
  tools[0]!.finished!.output = { toJSON: serialize };
  const html = renderToStaticMarkup(<ToolTraceList entries={entriesOf(...tools)} active={false} />);
  expect(html).toContain('data-read-tool-group="a"');
  expect(html).toContain('data-slot="marker"');
  expect(html).toContain("已读取 2 个文件");
  expect(html).toContain("3 次读取");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("data-tool-call-id");
  expect(html).not.toContain("private file content");
  expect(serialize).not.toHaveBeenCalled();
});

it("keeps failed, interrupted and still-running reads visible in a collapsed marker", () => {
  const failed = read("failed", "missing.ts");
  failed.finished!.isError = true;
  const pending = read("pending", "loading.ts");
  delete pending.finished;
  const active = renderToStaticMarkup(<ReadToolGroup id="group" tools={[failed, pending]} active />);
  expect(active).toContain('data-read-tool-group-state="error"');
  expect(active).toContain("正在读取 2 个文件");
  expect(active).toContain("1 项失败");
  expect(active).toContain("1/2 已结束");
  const stopped = renderToStaticMarkup(<ReadToolGroup id="group" tools={[failed, pending]} active={false} />);
  expect(stopped).toContain("1 项失败");
  expect(stopped).toContain("1 项中断");
});

it("preserves a singleton read as an independent row", () => {
  const html = renderToStaticMarkup(<ToolTraceList entries={entriesOf(read("a", "README.md"))} active={false} />);
  expect(html).toContain('data-tool-call-id="a"');
  expect(html).toContain("已读取 README.md");
  expect(html).not.toContain("data-read-tool-group=");
});
