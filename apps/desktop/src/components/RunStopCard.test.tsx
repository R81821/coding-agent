import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunStopInfo } from "@harness/protocol";
import { RunStopCard } from "./RunStopCard.js";

const stop: RunStopInfo = {
  code: "tool_call_limit",
  message: "工具调用预算已用完",
  phase: "local_verification",
  usage: {
    toolCalls: { used: 128, limit: 128 },
    modelTurns: { used: 42, limit: 64 },
    repairs: { used: 7, limit: null },
    usd: { used: 1.23, limit: 5 },
    durationMs: { used: 120000, limit: 1800000 },
  },
  pending: ["局部验证", "最终评审"],
  lastFailure: { tool: "apply_patch", message: "路径校验失败" },
};

describe("RunStopCard", () => {
  it("shows the actual stop cause and all used budgets, with unlimited repairs", () => {
    const html = renderToStaticMarkup(<RunStopCard stop={stop} />);
    for (const text of ["工具调用预算已用完", "工具 128/128", "模型 42/64", "修复 7 次／不限", "$1.23/$5.00", "2.0/30.0 分钟"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("模型轮次已用完");
    expect(html).not.toContain("/null");
  });

  it("keeps pending work and the last failure visible and puts diagnostics in a disclosure", () => {
    const html = renderToStaticMarkup(<RunStopCard stop={{ ...stop, summaryError: "总结请求失败" }} />);
    const visible = html.split("<details")[0];
    for (const text of ["局部验证", "最终评审", "apply_patch", "路径校验失败"]) expect(visible).toContain(text);
    expect(html).toContain("<summary");
    expect(html).toContain("tool_call_limit");
    expect(html).toContain("local_verification");
    expect(html).toContain("总结请求失败");
  });

  it("does not fabricate a stop card for historical results without stop metadata", () => {
    expect(renderToStaticMarkup(<RunStopCard />)).toBe("");
  });

  it("escapes failure output and handles missing optional diagnostics", () => {
    const { lastFailure: _lastFailure, ...withoutFailure } = stop;
    const html = renderToStaticMarkup(<RunStopCard stop={{ ...withoutFailure, pending: [], message: "<script>stop</script>" }} />);
    expect(html).toContain("&lt;script&gt;stop&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("最近失败");
    expect(html).not.toContain("待完成：");
  });
});
