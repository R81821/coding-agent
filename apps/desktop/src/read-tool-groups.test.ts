import { expect, it } from "vitest";
import type { ToolCallOrigin } from "@harness/protocol";
import type { ToolTimelineItem } from "./conversation-stream.js";
import { groupReadTools, summarizeReadTools } from "./read-tool-groups.js";

const base = { runId: "run", at: "2026-10-15T10:00:00.000Z", sequence: 0 };
const tool = (id: string, path: unknown = `${id}.ts`, name = "read_file", runId = "run", origin?: ToolCallOrigin): ToolTimelineItem => ({
  kind: "tool",
  started: {
    ...base, runId, id: `start-${id}`, type: "tool_started", call: { id, name, input: { path } },
    ...(origin ? { origin } : {}),
  },
});
const finish = (value: ToolTimelineItem, output: unknown = {}, isError?: boolean): ToolTimelineItem => ({
  ...value,
  finished: {
    ...base, runId: value.started.runId, id: `finish-${value.started.call.id}`, type: "tool_finished",
    callId: value.started.call.id, durationMs: 10, output, ...(isError === undefined ? {} : { isError }),
  },
});
const origin = (serverId = "server"): ToolCallOrigin => ({ serverId, serverName: "Files", toolName: "read_file", revision: 1 });

it("groups adjacent local reads and leaves empty or single-call groups unchanged", () => {
  const first = tool("first");
  const second = tool("second", "second.ts", "read_range");
  expect(groupReadTools([])).toEqual([]);
  expect(groupReadTools([first])).toEqual([{ kind: "tool", tool: first }]);
  expect(groupReadTools([first, second])).toEqual([{ kind: "read_group", id: first.started.id, tools: [first, second] }]);
});

it("preserves every call in its original order and never crosses another tool", () => {
  const first = tool("first");
  const second = tool("second");
  const search = tool("search", "src", "search_text");
  const third = tool("third");
  const fourth = tool("fourth");
  const tools = [first, second, search, third, fourth];
  const grouped = groupReadTools(tools);
  expect(grouped).toEqual([
    { kind: "read_group", id: first.started.id, tools: [first, second] },
    { kind: "tool", tool: search },
    { kind: "read_group", id: third.started.id, tools: [third, fourth] },
  ]);
  const flattened = grouped.flatMap(item => item.kind === "read_group" ? item.tools : [item.tool]);
  expect(flattened).toEqual(tools);
  flattened.forEach((item, index) => expect(item).toBe(tools[index]));
});

it("retains separate range reads of the same file without deduplicating calls", () => {
  const first = tool("first", "src/main.ts", "read_range");
  first.started.call.input.startLine = 1;
  first.started.call.input.endLine = 20;
  const second = tool("second", "src/main.ts", "read_range");
  second.started.call.input.startLine = 30;
  second.started.call.input.endLine = 50;
  expect(groupReadTools([first, second])).toEqual([{ kind: "read_group", id: first.started.id, tools: [first, second] }]);
  expect(summarizeReadTools([first, second], true)).toMatchObject({ fileCount: 1, callCount: 2, paths: ["src/main.ts"] });
});

it("does not combine reads from different runs", () => {
  const first = tool("first", "first.ts", "read_file", "run-one");
  const second = tool("second", "second.ts", "read_range", "run-two");
  const third = tool("third", "third.ts", "read_file", "run-two");
  expect(groupReadTools([first, second, third])).toEqual([
    { kind: "tool", tool: first },
    { kind: "read_group", id: second.started.id, tools: [second, third] },
  ]);
});

it("keeps MCP calls separate even when their names and origins match local reads", () => {
  const first = tool("first");
  const remoteOne = tool("remote-one", "one.ts", "read_file", "run", origin());
  const remoteTwo = tool("remote-two", "two.ts", "read_range", "run", origin());
  const otherRemote = tool("other-remote", "other.ts", "read_file", "run", origin("other"));
  const last = tool("last");
  expect(groupReadTools([first, remoteOne, remoteTwo, otherRemote, last])).toEqual(
    [first, remoteOne, remoteTwo, otherRemote, last].map(value => ({ kind: "tool", tool: value })),
  );
});

it("treats missing, blank, and non-string paths as grouping boundaries", () => {
  const first = tool("first");
  for (const path of [undefined, null, 12, "", " \t "]) {
    const invalid = tool("invalid", path);
    if (path === undefined) delete invalid.started.call.input.path;
    const last = tool("last");
    expect(groupReadTools([first, invalid, last])).toEqual([first, invalid, last].map(value => ({ kind: "tool", tool: value })));
  }
});

it("keeps a read group's identity stable when more reads or results arrive", () => {
  const first = tool("first");
  const second = tool("second");
  const initial = groupReadTools([first, second]);
  const completed = groupReadTools([finish(first), finish(second), tool("third")]);
  expect(initial[0]).toMatchObject({ kind: "read_group", id: first.started.id });
  expect(completed[0]).toMatchObject({ kind: "read_group", id: first.started.id });
});

it("does not mutate input arrays or the original call objects", () => {
  const first = tool("first");
  const second = tool("second");
  const tools = [first, second];
  const snapshot = structuredClone(tools);
  Object.freeze(tools);
  Object.freeze(first);
  Object.freeze(second);
  groupReadTools(tools);
  summarizeReadTools(tools, true);
  expect(tools).toEqual(snapshot);
});

it("normalizes path separators while preserving case and first-seen path order", () => {
  const tools = [
    finish(tool("first", "src\\Main.ts")),
    finish(tool("same", "src/Main.ts")),
    finish(tool("case-sensitive", "src/main.ts")),
    finish(tool("next", "other.ts")),
  ];
  expect(summarizeReadTools(tools, false)).toEqual({
    fileCount: 3, callCount: 4, completedCount: 4, failedCount: 0, interruptedCount: 0, runningCount: 0,
    paths: ["src/Main.ts", "src/main.ts", "other.ts"], state: "completed",
  });
});

it("reports failed and running reads together using the existing tool verdicts", () => {
  const tools = [
    finish(tool("completed")),
    finish(tool("explicit-failure"), {}, true),
    finish(tool("legacy-failure"), JSON.stringify({ error: "Permission denied" })),
    finish(tool("explicit-success"), { error: "Quoted output" }, false),
    tool("pending"),
  ];
  expect(summarizeReadTools(tools, true)).toMatchObject({
    callCount: 5, completedCount: 2, failedCount: 2, runningCount: 1, interruptedCount: 0, state: "error",
  });
  expect(summarizeReadTools(tools, false)).toMatchObject({
    completedCount: 2, failedCount: 2, runningCount: 0, interruptedCount: 1, state: "error",
  });
});

it("marks unfinished active reads running and unfinished stopped reads interrupted", () => {
  const tools = [finish(tool("completed")), tool("pending")];
  expect(summarizeReadTools(tools, true)).toMatchObject({ completedCount: 1, runningCount: 1, state: "running" });
  expect(summarizeReadTools(tools, false)).toMatchObject({ completedCount: 1, interruptedCount: 1, state: "interrupted" });
  expect(summarizeReadTools([], false)).toEqual({
    fileCount: 0, callCount: 0, completedCount: 0, failedCount: 0, interruptedCount: 0, runningCount: 0,
    paths: [], state: "completed",
  });
});
