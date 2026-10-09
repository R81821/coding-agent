import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "@harness/protocol";
import { FinalReportStatus } from "./FinalReportStatus.js";

it("shows the structured pending-review state near a report even when model prose claims completion", () => {
  const result = { id: "result", runId: "run", sequence: 4, at: "2026-10-08T03:55:00Z", type: "result", status: "review", text: "任务已完成", stop: { message: "独立审核未完成：输出被截断" } } as Extract<AgentEvent, { type: "result" }>;
  const html = renderToStaticMarkup(<FinalReportStatus result={result} />);
  expect(html).toContain('role="status"');
  expect(html).toContain("运行状态：待复核");
  expect(html).toContain("独立审核未完成：输出被截断");
  expect(html).not.toContain("审核通过");
});

it("keeps historical reports without metadata and internal pause instructions quiet", () => {
  expect(renderToStaticMarkup(<FinalReportStatus />)).toBe("");
  const paused = { id: "paused", runId: "run", sequence: 4, at: "2026-10-08T03:55:00Z", type: "result", status: "paused", text: "", stop: { message: "运行已暂停。可以继续，或补充说明后再继续。" } } as Extract<AgentEvent, { type: "result" }>;
  const html = renderToStaticMarkup(<FinalReportStatus result={paused} />);
  expect(html).toContain("已暂停");
  expect(html).not.toContain("可以继续，或补充说明");
});
