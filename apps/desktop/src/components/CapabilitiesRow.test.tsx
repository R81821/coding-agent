import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "@harness/protocol";
import { CapabilitiesRow } from "./CapabilitiesRow.js";

const base = { runId: "run", at: "2026-09-22T10:00:00.000Z", sequence: 0 };
const capabilities = (over: Record<string, unknown>) =>
  ({ ...base, id: "caps", type: "capabilities_resolved", mcp: [], diagnostics: [], skills: [], ...over }) as Extract<AgentEvent, { type: "capabilities_resolved" }>;

it("renders the resolved capability summary", () => {
  const html = renderToStaticMarkup(<CapabilitiesRow event={capabilities({ mcp: [{ serverId: "s1", revision: 1, toolName: "echo", name: "n", contractHash: "h", risk: "read" }], skills: [{ key: "k", name: "技能" }] })} />);
  expect(html).toContain("MCP 1 个工具 · 技能 1 个");
  expect(html).toContain("1 个服务可用");
  expect(html).not.toContain("activity-row-warning");
});

it("marks failing services in the warning style", () => {
  const html = renderToStaticMarkup(<CapabilitiesRow event={capabilities({ mcp: [{ serverId: "s1", revision: 1, toolName: "echo", name: "n", contractHash: "h", risk: "read" }], diagnostics: [{ serverId: "s2", name: "坏服务", error: "x" }] })} />);
  expect(html).toContain("activity-row-warning");
  expect(html).toContain("坏服务");
});

it("renders nothing when there is nothing to report", () => {
  expect(renderToStaticMarkup(<CapabilitiesRow event={capabilities({})} />)).toBe("");
});
