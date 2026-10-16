import type { AgentEvent } from "@harness/protocol";
import { expect, it } from "vitest";
import type { ToolGroupEntry } from "./conversation-stream.js";
import { groupToolEntries, summarizeOperations } from "./operation-groups.js";

const base = { runId: "run", at: "2026-10-15T00:00:00Z", sequence: 0 };

function tool(id: string, name: string, input: Record<string, unknown> = {}, state: "completed" | "error" | "pending" = "completed"): ToolGroupEntry {
  return {
    kind: "tool",
    tool: {
      kind: "tool",
      started: { ...base, id, type: "tool_started", call: { id: `call-${id}`, name, input } },
      ...(state === "pending" ? {} : {
        finished: { ...base, id: `${id}-finish`, sequence: 1, type: "tool_finished", callId: `call-${id}`, durationMs: 12, output: {}, ...(state === "error" ? { isError: true } : {}) },
      }),
    },
  } as ToolGroupEntry;
}

function approval(id: string, summary = 'probe (high): {"command":"ls"}', risk: "high" | "low" = "high"): ToolGroupEntry {
  return { kind: "approval", event: { ...base, id, type: "approval_required", approvalId: `approval-${id}`, summary, risk } as Extract<AgentEvent, { type: "approval_required" }> };
}

const labels = (entries: ToolGroupEntry[], active = false) => summarizeOperations(entries, active).label;

it("merges consecutive commands into one operation row that keeps their order", () => {
  const entries = [tool("a", "terminal", { command: "pnpm test" }), tool("b", "terminal", { command: "pnpm lint" })];
  const rows = groupToolEntries(entries);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "operation_group", id: "a" });
  const row = rows[0]!;
  expect(row.kind === "operation_group" && row.entries).toEqual(entries);
  expect(labels(entries)).toBe("运行了命令");
});

it("summarizes file edits and every other call in one sentence", () => {
  expect(labels([tool("a", "write_file", { path: "app.ts" }), tool("b", "terminal", { command: "pnpm test" })])).toBe("编辑了文件，运行了命令");
  expect(labels([tool("a", "apply_patch", { patch: "" }), tool("b", "web_search", {})])).toBe("编辑了文件，运行了命令");
  expect(labels([tool("a", "probe", { command: "python -" }), tool("b", "browser", { action: "snapshot" })])).toBe("运行了命令");
  expect(labels([tool("a", "write_file", { path: "app.ts" }), tool("b", "write_file", { path: "theme.ts" })])).toBe("编辑了文件");
});

it("keeps an approval inside the run it gates instead of splitting it", () => {
  const entries = [tool("a", "terminal", { command: "ls" }), approval("gate"), tool("b", "terminal", { command: "pwd" })];
  const rows = groupToolEntries(entries);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.kind === "operation_group" && row.entries.map(entry => entry.kind)).toEqual(["tool", "approval", "tool"]);
  expect(labels(entries)).toBe("运行了命令");
});

it("reports failures while still summarizing the whole group", () => {
  const entries = [tool("a", "terminal", { command: "ls" }, "error"), tool("b", "write_file", { path: "app.ts" }), approval("gate")];
  expect(summarizeOperations(entries, false).state).toBe("error");
  expect(labels(entries)).toBe("编辑了文件，运行了命令");
});

it("prefers running, then interrupted, over a completed group", () => {
  expect(summarizeOperations([tool("a", "terminal", {}, "pending"), tool("b", "terminal", {})], true).state).toBe("running");
  expect(summarizeOperations([tool("a", "terminal", {}, "pending"), tool("b", "terminal", {})], false).state).toBe("interrupted");
  expect(summarizeOperations([tool("a", "terminal", {}), tool("b", "terminal", {})], false).state).toBe("completed");
});

it("leaves a lone operation with its own detail row", () => {
  expect(groupToolEntries([tool("a", "terminal", { command: "pnpm test" })])).toEqual([{ kind: "tool", tool: expect.objectContaining({ kind: "tool" }) }]);
});

it("keeps adjacent reads grouped and splits the runs on either side of them", () => {
  const entries = [
    tool("a", "terminal", { command: "ls" }),
    tool("b", "read_file", { path: "app.ts" }),
    tool("c", "read_file", { path: "theme.ts" }),
    tool("d", "terminal", { command: "pwd" }),
  ];
  const rows = groupToolEntries(entries);
  expect(rows.map(row => row.kind)).toEqual(["tool", "read_group", "tool"]);
  const reads = rows[1]!;
  expect(reads.kind === "read_group" && reads.tools.map(item => item.started.id)).toEqual(["b", "c"]);
});

it("keeps an approval visible when it follows only reads", () => {
  const entries = [tool("a", "read_file", { path: "app.ts" }), tool("b", "read_file", { path: "theme.ts" }), approval("gate")];
  expect(groupToolEntries(entries).map(row => row.kind)).toEqual(["read_group", "approval"]);
});
