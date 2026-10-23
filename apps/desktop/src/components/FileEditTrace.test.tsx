import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolTimelineItem } from "../conversation-stream.js";
import { ToolTraceRow } from "./ConversationTrace.js";
import { ToolTraceList } from "./ReadToolGroup.js";

const diff = "--- /dev/null\n+++ b/_probe.html\n@@ -0,0 +1,4 @@\n+<!doctype html>\n+<html>\n+PIXEL PROBE\n+</html>\n";
const base = { runId: "run", at: "2026-10-20T00:00:00.000Z", sequence: 0 };
const writing = (output: unknown, extras: Partial<ToolTimelineItem["finished"]> = {}): ToolTimelineItem => ({ kind: "tool",
  started: { ...base, id: "start", type: "tool_started", call: { id: "write", name: "write_file", input: { path: "_probe.html", content: "PRIVATE_FULL_INPUT" } } },
  finished: { ...base, id: "finish", sequence: 1, type: "tool_finished", callId: "write", output, durationMs: 12, ...extras },
});
const receipt = { written: true, path: "_probe.html", byteLength: 1024, created: true, changed: true, diff, diffTruncated: false, added: 4, deleted: 0 };

describe("per-operation code change trace", () => {
  it("shows a successful actual write as an expanded compact code panel with real counts", () => {
    const html = renderToStaticMarkup(<ToolTraceRow tool={writing(receipt)} active={false} />);
    expect(html).toContain("conversation-file-edit-row");
    expect(html).toContain("写入 ·");
    expect(html).toContain("_probe.html");
    expect(html).toContain("1 KB");
    expect(html).toContain("+4");
    expect(html).toContain("−0");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("tool-edit-panel");
    expect(html).toContain("tool-edit-line-add");
    expect(html).toContain("html");
    expect(html).toContain('aria-label="复制差异"');
    expect(html).toContain("tool-edit-scroll");
    expect(html).toContain("&lt;!doctype html&gt;");
    expect(html).not.toContain("PRIVATE_FULL_INPUT");
  });

  it("shows edits and commands in order without hiding the file panel in the command group", () => {
    const command = writing({ exitCode: 0 });
    command.started = { ...command.started, id: "command", call: { id: "command", name: "terminal", input: { command: "pnpm test" } } };
    const html = renderToStaticMarkup(<ToolTraceList entries={[{ kind: "tool", tool: command }, { kind: "tool", tool: writing(receipt) }]} active={false} />);
    expect(html).toContain("tool-edit-panel");
    expect(html.indexOf("pnpm test")).toBeLessThan(html.indexOf("写入 ·"));
    expect(html).not.toContain('data-operation-group="');
  });

  it("does not show successful changes for failed, interrupted, pending or remote writes", () => {
    const failed = renderToStaticMarkup(<ToolTraceRow tool={writing({ ...receipt, written: false }, { isError: true })} active={false} />);
    expect(failed).toContain("写入失败");
    expect(failed).not.toContain("tool-edit-panel");
    expect(failed).not.toContain("+4");
    const pending = writing(receipt); delete pending.finished;
    expect(renderToStaticMarkup(<ToolTraceRow tool={pending} active />)).toContain("正在写入");
    expect(renderToStaticMarkup(<ToolTraceRow tool={pending} active={false} />)).toContain("写入已中断");
    const remote = writing(receipt);
    remote.started.origin = { serverId: "remote", serverName: "远端", toolName: "write_file", revision: 1 };
    const html = renderToStaticMarkup(<ToolTraceRow tool={remote} active={false} />);
    expect(html).toContain("远端 · write_file");
    expect(html).not.toContain("tool-edit-panel");
  });

  it("marks incomplete previews honestly and leaves unchanged content without invented edit counts", () => {
    const incomplete = renderToStaticMarkup(<ToolTraceRow tool={writing({ ...receipt, added: undefined, deleted: undefined, diffTruncated: true })} active={false} />);
    expect(incomplete).toContain("预览已截断");
    expect(incomplete).toContain("统计未完整");
    expect(incomplete).not.toContain("tool-edit-count-add");
    const unchanged = renderToStaticMarkup(<ToolTraceRow tool={writing({ ...receipt, changed: false, added: 0, deleted: 0, diff: "" })} active={false} />);
    expect(unchanged).toContain("内容未变");
    expect(unchanged).not.toContain("tool-edit-line-add");
    expect(unchanged).not.toContain("tool-edit-count-add");
  });

  it("restores the same confirmed panel after a saved receipt hydrates as JSON text", () => {
    const html = renderToStaticMarkup(<ToolTraceRow tool={writing(JSON.stringify(receipt, null, 2))} active={false} />);
    expect(html).toContain("tool-edit-panel");
    expect(html).toContain("写入 ·");
    expect(html).toContain("+4");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("此记录没有可确认的代码变更回执");
    expect(html).not.toContain("PRIVATE_FULL_INPUT");
  });
});
