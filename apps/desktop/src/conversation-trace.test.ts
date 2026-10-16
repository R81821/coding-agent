import { expect, it } from "vitest";
import type { AgentEvent } from "@harness/protocol";
import { extractConversationSources, getToolTraceState, sourceEventsForSegment } from "./conversation-trace.js";

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;
const base = { runId: "run", at: "2026-10-15T10:00:00.000Z", sequence: 0 };
const started = (id: string, name = "web_search", input: Record<string, unknown> = {}): ToolStartedEvent =>
  ({ ...base, id: `start-${id}`, type: "tool_started", call: { id, name, input } });
const finished = (id: string, output: unknown, isError?: boolean): ToolFinishedEvent =>
  ({ ...base, id: `finish-${id}`, sequence: 1, type: "tool_finished", callId: id, durationMs: 10, output, ...(isError === undefined ? {} : { isError }) });
const searchResult = (url: string, title?: string) => ({ url, title, excerpts: [] });

it("extracts actual live and hydrated search results and deduplicates normalized URLs", () => {
  const events = [
    started("live"), finished("live", { results: [searchResult("https://Example.com/docs", "文档"), searchResult("https://example.com/other", "其他")] }),
    started("history"), finished("history", JSON.stringify({ results: [searchResult("https://example.com/docs", "重复"), searchResult("https://example.com", "主页")] })),
  ];
  expect(extractConversationSources(events)).toEqual({ sources: [
    { url: "https://example.com/docs", title: "文档" },
    { url: "https://example.com/other", title: "其他" },
    { url: "https://example.com/", title: "主页" },
  ], pending: false });
});

it("rejects unsafe source URLs and uses a hostname for missing titles", () => {
  const urls = ["javascript:alert(1)", "file:///C:/secret", "data:text/html,hi", "https://user:pass@example.com", "//example.com", "https://", "https://example.com/valid"];
  expect(extractConversationSources([started("search"), finished("search", { results: urls.map(url => searchResult(url)) })]))
    .toEqual({ sources: [{ url: "https://example.com/valid", title: "example.com" }], pending: false });
});

it("reports deferred source hydration until the canonical output replaces it", () => {
  const start = started("search");
  expect(extractConversationSources([start, finished("search", { deferred: true })])).toEqual({ sources: [], pending: true });
  expect(extractConversationSources([start, finished("search", JSON.stringify({ deferred: true }))])).toEqual({ sources: [], pending: true });
  expect(extractConversationSources([start, finished("search", JSON.stringify({ results: [searchResult("https://example.com", "文档")] }))]))
    .toEqual({ sources: [{ url: "https://example.com/", title: "文档" }], pending: false });
  expect(extractConversationSources([start])).toEqual({ sources: [], pending: false });
});

it("does not extract failed searches or URLs from terminal logs and arbitrary nested data", () => {
  const result = { results: [searchResult("https://example.com", "文档")], url: "https://example.com/top" };
  const events = [
    started("failed"), finished("failed", result, true),
    started("structured-failed"), finished("structured-failed", { ...result, error: "search failed" }),
    started("terminal", "terminal"), finished("terminal", { stdout: JSON.stringify(result), ...result }),
    started("nested"), finished("nested", { stdout: JSON.stringify(result), log: result, results: [{ nested: result }] }),
    started("orphan"), finished("other-call", result),
    started("plain"), finished("plain", "Found https://example.com in output"),
  ];
  expect(extractConversationSources(events)).toEqual({ sources: [], pending: false });
});

it("uses only the successful visited document URL from explicitly supported browser actions", () => {
  const events = [
    started("navigate", "browser", { action: "navigate", url: "https://requested.example" }),
    finished("navigate", { url: "https://actual.example/docs", title: "实际文档", links: [searchResult("https://unvisited.example")] }),
    started("snapshot", "browser", { action: "snapshot" }),
    finished("snapshot", JSON.stringify({ url: "https://actual.example/docs", title: "实际文档", text: "See https://unvisited.example" })),
    started("tabs", "browser", { action: "tabs" }), finished("tabs", { tabs: [searchResult("https://tab.example")], url: "https://tab.example" }),
    started("fill", "browser", { action: "fill" }), finished("fill", { url: "https://form.example", title: "表单" }),
    started("failed", "browser", { action: "navigate" }), finished("failed", { url: "https://failed.example" }, true),
    started("input-only", "browser", { action: "navigate", url: "https://requested.example" }), finished("input-only", { success: true }),
  ];
  expect(extractConversationSources(events)).toEqual({ sources: [{ url: "https://actual.example/docs", title: "实际文档" }], pending: false });
});

it("matches sources by both run and call identity and ignores unrelated deferred output", () => {
  expect(extractConversationSources([
    started("same", "terminal"), { ...started("same"), runId: "other-run" },
    finished("same", { results: [searchResult("https://example.com")] }),
    started("deferred", "read_file"), finished("deferred", { deferred: true }),
    started("failed"), finished("failed", { deferred: true }, true),
  ])).toEqual({ sources: [], pending: false });
});

it("updates a deduplicated URL's hostname fallback when its real title becomes available", () => {
  expect(extractConversationSources([
    started("first"), finished("first", { results: [searchResult("https://example.com")] }),
    started("second"), finished("second", { results: [searchResult("https://example.com/", "正式标题")] }),
  ]).sources).toEqual([{ url: "https://example.com/", title: "正式标题" }]);
});

it("assigns a search finishing after a human reply only to the segment where it started", () => {
  const events: AgentEvent[] = [
    started("before"),
    { ...base, id: "reply", sequence: 1, type: "steering_submitted", messageId: "reply", text: "补充说明" },
    { ...started("after", "browser", { action: "snapshot" }), sequence: 2 },
    { ...finished("before", { results: [searchResult("https://before.example", "先前检索")] }), sequence: 3 },
    { ...finished("after", { url: "https://after.example", title: "后续文档" }), sequence: 4 },
  ];
  const first = sourceEventsForSegment(events, events.filter(event => event.sequence < 1));
  const second = sourceEventsForSegment(events, events.filter(event => event.sequence >= 1));
  expect(first.map(event => event.sequence)).toEqual([0, 3]);
  expect(second.map(event => event.sequence)).toEqual([2, 4]);
  expect(extractConversationSources(first).sources).toEqual([{ url: "https://before.example/", title: "先前检索" }]);
  expect(extractConversationSources(second).sources).toEqual([{ url: "https://after.example/", title: "后续文档" }]);
  expect(events).toHaveLength(5);
});

it("keeps parallel source events in canonical order and separates reused call IDs across runs", () => {
  const events: AgentEvent[] = [
    started("same"),
    { ...started("parallel"), sequence: 1 },
    { ...started("same"), sequence: 2, runId: "other-run" },
    { ...finished("parallel", { results: [searchResult("https://parallel.example")] }), sequence: 3 },
    { ...finished("same", { results: [searchResult("https://other.example")] }), sequence: 4, runId: "other-run" },
    { ...finished("same", { results: [searchResult("https://first.example")] }), sequence: 5 },
  ];
  const sourceEvents = sourceEventsForSegment(events, events.slice(0, 2));
  expect(sourceEvents.map(event => event.id)).toEqual(["start-same", "start-parallel", "finish-parallel", "finish-same"]);
  expect(sourceEvents.map(event => event.sequence)).toEqual([0, 1, 3, 5]);
  expect(sourceEvents.every(event => event.runId === "run")).toBe(true);
  expect(extractConversationSources(sourceEvents).sources.map(source => source.url)).toEqual(["https://parallel.example/", "https://first.example/"]);
});

it("projects the latest hydrated source output without including unrelated tool events", () => {
  const sourceStart = started("source");
  const segmentEvents = [sourceStart, started("file", "read_file"), finished("file", { deferred: true })];
  const pending = [...segmentEvents, finished("source", { deferred: true })];
  expect(extractConversationSources(sourceEventsForSegment(pending, segmentEvents))).toEqual({ sources: [], pending: true });
  const hydrated = [...segmentEvents, finished("source", JSON.stringify({ results: [searchResult("https://example.com")] }))];
  expect(extractConversationSources(sourceEventsForSegment(hydrated, segmentEvents)))
    .toEqual({ sources: [{ url: "https://example.com/", title: "example.com" }], pending: false });
  expect(sourceEventsForSegment(hydrated, segmentEvents.slice(1))).toEqual([]);
});

it("marks unfinished stopped tool calls interrupted and keeps active calls running", () => {
  const start = started("terminal", "terminal");
  expect(getToolTraceState(start, undefined, true)).toBe("running");
  expect(getToolTraceState(start, undefined, false)).toBe("interrupted");
  expect(getToolTraceState(start, finished("terminal", { exitCode: 0 }), false)).toBe("completed");
});

it("honors the explicit engine verdict ahead of legacy output heuristics", () => {
  const start = started("terminal", "terminal");
  expect(getToolTraceState(start, finished("terminal", { exitCode: 1, error: "not a tool failure", timedOut: true }, false), false)).toBe("completed");
  expect(getToolTraceState(start, finished("terminal", { exitCode: 0, isError: false }, true), false)).toBe("error");
});

it("detects legacy structured failures, terminal exit codes, and timeout output", () => {
  const start = started("terminal", "terminal");
  for (const output of [
    { error: "execution failed" }, { error: { code: "failed", message: "失败" } }, { isError: true },
    { exitCode: 2 }, { exitCode: null }, { timedOut: true }, { timeout: true }, { status: "timed_out" },
    JSON.stringify({ exitCode: 127 }),
  ]) expect(getToolTraceState(start, finished("terminal", output), false)).toBe("error");
  for (const output of [{ error: null, exitCode: 0 }, { error: "", timeoutMs: 1000 }, "Error mentioned in normal text", { stdout: "fatal: quoted example", stderr: "warning" }]) {
    expect(getToolTraceState(start, finished("terminal", output), false)).toBe("completed");
  }
});
