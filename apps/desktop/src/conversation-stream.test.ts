import { expect, it } from "vitest";
import { buildConversationStream, capabilitiesSummary, type ConversationStreamItem } from "./conversation-stream.js";
import type { AgentEvent } from "@harness/protocol";

const base = { runId: "run", at: "2026-09-22T10:00:00.000Z", sequence: 0 };
const toolStarted = (id: string, sequence: number) =>
  ({ ...base, id, sequence, type: "tool_started", call: { id: `call-${id}`, name: "read_file", input: {} } } as AgentEvent);
const toolFinished = (id: string, sequence: number) =>
  ({ ...base, id, sequence, type: "tool_finished", callId: `call-${id}`, durationMs: 1, output: {} } as AgentEvent);
const groupsIn = (stream: ConversationStreamItem[]) =>
  stream.filter((item) => item.kind === "tool_group");

it("keeps consecutive tool calls in one group across a model turn boundary", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "turn", sequence: 1, type: "assistant_turn_started" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  const groups = groupsIn(stream);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.tools).toHaveLength(2);
});

it("keeps self-correction markers inside the tool group but splits on a retry", () => {
  const correction = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "fix", sequence: 1, type: "self_correction_started", attempt: 1, summary: "重试" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  expect(groupsIn(correction)).toHaveLength(1);
  expect(groupsIn(correction)[0]?.tools).toHaveLength(2);

  const retry = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "retry", sequence: 1, type: "provider_retry", attempt: 1, maxAttempts: 2, delayMs: 10, category: "transient", recovery: "retry_request", reason: "超时" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  expect(groupsIn(retry)).toHaveLength(2);
});

it("records finished tool calls and appends the final result once", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    toolFinished("a", 1),
    { ...base, id: "delta", sequence: 2, type: "text_delta", delta: "答案" } as AgentEvent,
    { ...base, id: "result", sequence: 3, type: "result", text: "答案", status: "completed" } as AgentEvent,
  ]);
  expect(groupsIn(stream)[0]?.tools[0]?.finished?.durationMs).toBe(1);
  const texts = stream.filter((item) => item.kind === "text");
  expect(texts).toHaveLength(1);
  expect(texts[0]?.text).toBe("答案");
  expect(texts[0]?.process).toBe(false);
});

it("ignores an orphan tool result without breaking later conversation events", () => {
  const stream = buildConversationStream([
    toolFinished("missing", 0),
    toolStarted("present", 1),
    toolFinished("present", 2),
    { ...base, id: "result", sequence: 3, type: "result", text: "完成", status: "completed" } as AgentEvent,
  ]);
  expect(groupsIn(stream)[0]?.tools[0]?.finished?.callId).toBe("call-present");
  expect(stream.at(-1)).toMatchObject({ kind: "text", text: "完成", process: false });
});

it("does not render the internal pause instruction from streamed or final text", () => {
  const paused = "运行已暂停。可以继续，或补充说明后再继续。";
  const stream = buildConversationStream([
    { ...base, id: "delta", sequence: 0, type: "text_delta", delta: paused } as AgentEvent,
    { ...base, id: "result", sequence: 1, type: "result", text: paused, status: "paused" } as AgentEvent,
  ]);
  expect(stream).toEqual([]);
});

it("streams one process message between tool groups across model turns", () => {
  const before = [
    toolStarted("a", 0),
    toolFinished("a", 1),
    { ...base, id: "first", sequence: 2, type: "text_delta", delta: "配置已检查。" } as AgentEvent,
    { ...base, id: "next-turn", sequence: 3, type: "assistant_turn_started" } as AgentEvent,
  ];
  const partial = buildConversationStream(before);
  const extended = buildConversationStream([
    ...before,
    { ...base, id: "second", sequence: 4, type: "text_delta", delta: "继续查看日志。" } as AgentEvent,
  ]);
  const complete = buildConversationStream([
    ...before,
    { ...base, id: "second", sequence: 4, type: "text_delta", delta: "继续查看日志。" } as AgentEvent,
    toolStarted("b", 5),
  ]);

  expect(partial.filter((item) => item.kind === "text")).toMatchObject([
    { id: "text-0", text: "配置已检查。", process: true },
  ]);
  expect(extended.filter((item) => item.kind === "text")).toMatchObject([
    { id: "text-0", text: "配置已检查。 继续查看日志。", process: true },
  ]);
  expect(complete.filter((item) => item.kind === "text")).toMatchObject([
    { id: "text-0", text: "配置已检查。 继续查看日志。", process: true },
  ]);
  expect(groupsIn(complete)).toHaveLength(2);
});

it("keeps the final answer separate from earlier process text", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    toolFinished("a", 1),
    { ...base, id: "progress", sequence: 2, type: "text_delta", delta: "先检查依赖。" } as AgentEvent,
    { ...base, id: "answer-turn", sequence: 3, type: "assistant_turn_started" } as AgentEvent,
    { ...base, id: "answer", sequence: 4, type: "text_delta", delta: "问题已修复。" } as AgentEvent,
    { ...base, id: "result", sequence: 5, type: "result", text: "问题已修复。", status: "completed" } as AgentEvent,
  ]);
  expect(stream.filter((item) => item.kind === "text")).toMatchObject([
    { text: "先检查依赖。", process: true },
    { text: "问题已修复。", process: false },
  ]);
});

it("keeps progress separate when the final turn has no streamed delta", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "progress", sequence: 1, type: "text_delta", delta: "先检查依赖。" } as AgentEvent,
    { ...base, id: "answer-turn", sequence: 2, type: "assistant_turn_started" } as AgentEvent,
    { ...base, id: "result", sequence: 3, type: "result", text: "问题已修复。", status: "completed" } as AgentEvent,
  ]);
  expect(stream.filter((item) => item.kind === "text")).toMatchObject([
    { text: "先检查依赖。", process: true },
    { text: "问题已修复。", process: false },
  ]);
});

it("does not expose a streamed pause instruction after progress", () => {
  const paused = "运行已暂停。可以继续，或补充说明后再继续。";
  const stream = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "progress", sequence: 1, type: "text_delta", delta: "已经读取配置。" } as AgentEvent,
    { ...base, id: "pause-turn", sequence: 2, type: "assistant_turn_started" } as AgentEvent,
    { ...base, id: "pause-delta", sequence: 3, type: "text_delta", delta: paused } as AgentEvent,
    { ...base, id: "result", sequence: 4, type: "result", text: paused, status: "paused" } as AgentEvent,
  ]);
  expect(stream.filter((item) => item.kind === "text")).toMatchObject([
    { text: "已经读取配置。", process: true },
  ]);
});

it("summarizes resolved MCP capabilities and failure diagnostics", () => {
  const resolved = (mcp: unknown[], diagnostics: unknown[], skills: unknown[]) =>
    ({ ...base, id: "caps", sequence: 0, type: "capabilities_resolved", mcp, diagnostics, skills } as Extract<AgentEvent, { type: "capabilities_resolved" }>);
  const tool = { serverId: "s1", revision: 1, toolName: "echo", name: "mcp_x_echo_y", contractHash: "h", risk: "read" };
  expect(capabilitiesSummary(resolved([tool], [], [{ key: "k", name: "技能" }])))
    .toEqual({ label: "MCP 1 个工具 · 技能 1 个", detail: "1 个服务可用", warning: false });
  expect(capabilitiesSummary(resolved([], [{ serverId: "s2", name: "坏服务", error: "x" }], [])))
    .toEqual({ label: "MCP 0 个工具 · 技能 0 个", detail: "1 个服务不可用：坏服务", warning: true });
  // Every run emits this event; with nothing to report the row must stay hidden.
  expect(capabilitiesSummary(resolved([], [], []))).toBeUndefined();
});

it("surfaces the capabilities summary event at the start of the stream", () => {
  const stream = buildConversationStream([
    { ...base, id: "caps", sequence: 0, type: "capabilities_resolved", mcp: [], diagnostics: [], skills: [] } as AgentEvent,
  ]);
  expect(stream).toHaveLength(1);
  expect(stream[0]).toMatchObject({ kind: "event", event: { type: "capabilities_resolved" } });
});
