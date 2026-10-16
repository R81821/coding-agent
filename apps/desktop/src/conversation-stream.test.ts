import { expect, it, vi } from "vitest";
import { buildConversationStream, capabilitiesSummary, type ConversationStreamItem } from "./conversation-stream.js";
import { DEFAULT_PROFILE, SessionContentLoader, type AgentEvent, type SessionView } from "@harness/protocol";

const base = { runId: "run", at: "2026-09-22T10:00:00.000Z", sequence: 0 };
const toolStarted = (id: string, sequence: number) =>
  ({ ...base, id, sequence, type: "tool_started", call: { id: `call-${id}`, name: "read_file", input: {} } } as AgentEvent);
const toolFinished = (id: string, sequence: number) =>
  ({ ...base, id, sequence, type: "tool_finished", callId: `call-${id}`, durationMs: 1, output: {} } as AgentEvent);
const groupsIn = (stream: ConversationStreamItem[]) =>
  stream.filter((item) => item.kind === "tool_group");
const toolsIn = (group: Extract<ConversationStreamItem, { kind: "tool_group" }>) =>
  group.entries.flatMap((entry) => entry.kind === "tool" ? [entry.tool] : []);

it("keeps consecutive tool calls in one group across a model turn boundary", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "turn", sequence: 1, type: "assistant_turn_started" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  const groups = groupsIn(stream);
  expect(groups).toHaveLength(1);
  expect(toolsIn(groups[0]!)).toHaveLength(2);
});

it("keeps self-correction markers inside the tool group but splits on a retry", () => {
  const correction = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "fix", sequence: 1, type: "self_correction_started", attempt: 1, summary: "重试" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  expect(groupsIn(correction)).toHaveLength(1);
  expect(toolsIn(groupsIn(correction)[0]!)).toHaveLength(2);

  const retry = buildConversationStream([
    toolStarted("a", 0),
    { ...base, id: "retry", sequence: 1, type: "provider_retry", attempt: 1, maxAttempts: 2, delayMs: 10, category: "transient", recovery: "retry_request", reason: "超时" } as AgentEvent,
    toolStarted("b", 2),
  ]);
  expect(groupsIn(retry)).toHaveLength(2);
});

it("keeps an approval with the run it gates instead of splitting the group", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    toolFinished("a", 1),
    { ...base, id: "gate", sequence: 2, type: "approval_required", approvalId: "approval", summary: 'terminal (high): {"command":"ls"}', risk: "high" } as AgentEvent,
    toolStarted("b", 3),
  ]);
  const groups = groupsIn(stream);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.entries.map(entry => entry.kind)).toEqual(["tool", "approval", "tool"]);
  expect(stream.filter(item => item.kind === "event")).toEqual([]);

  const standalone = buildConversationStream([
    { ...base, id: "gate", sequence: 0, type: "approval_required", approvalId: "approval", summary: 'terminal (high): {"command":"ls"}', risk: "high" } as AgentEvent,
  ]);
  expect(standalone.map(item => item.kind)).toEqual(["event"]);
});

it("records finished tool calls and appends the final result once", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0),
    toolFinished("a", 1),
    { ...base, id: "delta", sequence: 2, type: "text_delta", delta: "答案" } as AgentEvent,
    { ...base, id: "result", sequence: 3, type: "result", text: "答案", status: "completed" } as AgentEvent,
  ]);
  expect(toolsIn(groupsIn(stream)[0]!)[0]?.finished?.durationMs).toBe(1);
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
  expect(toolsIn(groupsIn(stream)[0]!)[0]?.finished?.callId).toBe("call-present");
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

const turnStarted = (sequence: number, runId = "run") =>
  ({ ...base, id: `turn-${runId}-${sequence}`, runId, sequence, type: "assistant_turn_started" } as AgentEvent);
const textDelta = (sequence: number, delta: string, runId = "run") =>
  ({ ...base, id: `delta-${runId}-${sequence}`, runId, sequence, type: "text_delta", delta } as AgentEvent);
const resultEvent = (sequence: number, text: string, sourceAssistantTurnSequence?: number) =>
  ({ ...base, id: `result-${sequence}`, sequence, type: "result", text, status: "review", ...(sourceAssistantTurnSequence !== undefined ? { sourceAssistantTurnSequence } : {}) } as AgentEvent);
const textItems = (events: AgentEvent[]) => buildConversationStream(events).filter(item => item.kind === "text");

it("replaces a streamed source report with the authoritative result and keeps its review status", () => {
  const stream = textItems([
    turnStarted(0), textDelta(1, "报告已完成。"),
    resultEvent(2, "报告已完成。\n\n独立审核未完成；报告尚未经独立审核确认。", 0),
  ]);
  expect(stream).toHaveLength(1);
  expect(stream[0]).toMatchObject({ text: "报告已完成。\n\n独立审核未完成；报告尚未经独立审核确认。", process: false, result: { status: "review" } });
});

it("replaces a shortened or corrected source report without similarity matching", () => {
  const stream = textItems([
    turnStarted(0), textDelta(1, "早期版本需要保留。"),
    turnStarted(2), textDelta(3, "这一份很长的报告包含过时的完成描述。"),
    resultEvent(4, "纠正后的简短报告。", 2),
  ]);
  expect(stream).toMatchObject([
    { text: "早期版本需要保留。", process: true },
    { text: "纠正后的简短报告。", process: false },
  ]);
});

it("can replace a report already flushed by an activity event", () => {
  const stream = textItems([
    turnStarted(0), textDelta(1, "候选报告"),
    { ...base, id: "error", sequence: 2, type: "error", message: "审核请求失败", code: "review_failed" } as AgentEvent,
    resultEvent(3, "候选报告\n\n独立审核未完成", 0),
  ]);
  expect(stream).toHaveLength(1);
  expect(stream[0]?.text).toBe("候选报告\n\n独立审核未完成");
});

it("only replaces the referenced run and leaves later different text intact", () => {
  const stream = textItems([
    turnStarted(0, "earlier"), textDelta(1, "其他运行正文", "earlier"),
    turnStarted(0), textDelta(2, "候选报告"),
    turnStarted(3), textDelta(4, "独立的后续说明"),
    resultEvent(5, "审核后的报告", 0),
  ]);
  expect(stream.map(item => item.text).join("\n")).toContain("其他运行正文");
  expect(stream.map(item => item.text).join("\n")).toContain("独立的后续说明");
  expect(stream.map(item => item.text).join("\n")).not.toContain("候选报告");
  expect(stream.at(-1)?.text).toBe("审核后的报告");
});

it("projects the same final body from live events, canonical replay, and result-only preview hydration", () => {
  const final = resultEvent(4, "原报告\n\n审核未完成", 2);
  const events = [turnStarted(0), textDelta(1, "过程说明"), turnStarted(2), textDelta(3, "原报告"), final];
  const preview = [final];
  const body = (items: AgentEvent[]) => textItems(items).filter(item => !item.process).map(item => item.text);
  expect(body(preview)).toEqual([final.type === "result" ? final.text : ""]);
  expect(body(events)).toEqual(body(preview));
  expect(body(JSON.parse(JSON.stringify(events)) as AgentEvent[])).toEqual(body(preview));
  // Canonical history replaces the synthetic preview, rather than adding its text again.
  expect(body([...events.slice(0, -1), ...preview])).toEqual(body(preview));
});

it("keeps one authoritative report while canonical event pages replace a session preview", async () => {
  vi.useFakeTimers();
  const final = resultEvent(4, "原报告\n\n审核未完成", 2);
  const events = [turnStarted(0), textDelta(1, "过程说明"), turnStarted(2), textDelta(3, "原报告"), final];
  let view: SessionView = {
    session: { id: "session", title: "fixture", workspacePath: "D:/fixture", profileId: "default", createdAt: base.at, updatedAt: base.at },
    hasMore: false,
    runs: [{
      spec: { id: "run", sessionId: "session", request: "分析", workspacePath: "D:/fixture", profileId: "default", budget: DEFAULT_PROFILE.budget, attachments: [], grants: [], createdAt: base.at },
      status: "review", events: [final], view: { lastSequence: 4, eventsComplete: false },
    }],
  };
  const loader = new SessionContentLoader({
    sessionId: "session", read: () => view, update: change => { view = change(view); }, onError: message => { throw Error(message); },
    request: async <T>(input: { method: string; params?: unknown }) => {
      if (input.method !== "run.eventPage") throw Error(input.method);
      const after = (input.params as { afterSequence: number }).afterSequence;
      return { events: after < 0 ? events.slice(0, 2) : events.slice(2), nextSequence: after < 0 ? 1 : 4, hasMore: after < 0, status: "review" } as T;
    },
  });
  const reports = () => textItems(view.runs[0]!.events).filter(item => !item.process).map(item => item.text);
  try {
    expect(reports()).toEqual(["原报告\n\n审核未完成"]);
    loader.wake();
    await vi.advanceTimersByTimeAsync(16);
    expect(view.runs[0]?.view?.eventsComplete).toBe(false);
    expect(reports()).toEqual(["原报告\n\n审核未完成"]);
    await vi.advanceTimersByTimeAsync(32);
    expect(view.runs[0]?.view?.eventsComplete).toBe(true);
    expect(view.runs[0]?.events).toEqual(events);
    expect(reports()).toEqual(["原报告\n\n审核未完成"]);
  } finally {
    loader.stop();
    vi.useRealTimers();
  }
});

it("uses exact legacy fallback when preview omitted a referenced turn marker", () => {
  expect(textItems([textDelta(1, "原报告"), resultEvent(2, "原报告\n\n待复核", 0)]))
    .toMatchObject([{ text: "原报告\n\n待复核", process: false }]);
  const distinct = textItems([textDelta(1, "独立的历史说明"), resultEvent(2, "当前报告", 0)]);
  expect(distinct).toMatchObject([{ text: "独立的历史说明", process: true }, { text: "当前报告", process: false }]);
  const knownOtherTurn = textItems([turnStarted(2), textDelta(3, "相同正文"), resultEvent(4, "相同正文\n\n待复核", 0)]);
  expect(knownOtherTurn).toMatchObject([{ text: "相同正文", process: true }, { text: "相同正文\n\n待复核", process: false }]);
});

it("merges an old exact final paragraph extension but keeps other versions", () => {
  const old = textItems([
    turnStarted(0), textDelta(1, "早期报告"), turnStarted(2), textDelta(3, "原报告"),
    resultEvent(4, "原报告\n\n待复核"),
  ]);
  expect(old).toMatchObject([{ text: "早期报告", process: true }, { text: "原报告\n\n待复核", process: false }]);
  const different = textItems([turnStarted(0), textDelta(1, "详细原报告"), resultEvent(2, "原报告")]);
  expect(different.map(item => item.text)).toEqual(["详细原报告", "原报告"]);
  const flushed = textItems([
    turnStarted(0), textDelta(1, "原报告"),
    { ...base, id: "error", sequence: 2, type: "error", message: "审核请求失败", code: "review_failed" } as AgentEvent,
    resultEvent(3, "原报告\n\n待复核"),
  ]);
  expect(flushed.map(item => item.text)).toEqual(["原报告\n\n待复核"]);
});

it("preserves pause semantics even when a source reference is supplied", () => {
  const final = { ...resultEvent(2, "运行已暂停。可以继续，或补充说明后再继续。", 0), status: "paused" } as AgentEvent;
  expect(textItems([turnStarted(0), textDelta(1, "已收集的证据。"), final]))
    .toMatchObject([{ text: "已收集的证据。", process: true }]);
});

const submitted = (sequence: number, messageId: string, text: string): AgentEvent =>
  ({ ...base, id: `submitted-${sequence}`, sequence, type: "steering_submitted", messageId, text });
const delivered = (sequence: number, text: string, messageId?: string): AgentEvent =>
  ({ ...base, id: `delivered-${sequence}`, sequence, type: "steering_delivered", text, ...(messageId ? { messageId } : {}) });

it("inserts submitted human messages between separate assistant paragraphs", () => {
  expect(buildConversationStream([
    turnStarted(0), textDelta(1, "原来的思路。"), submitted(2, "correction", "换个方向"),
    turnStarted(3), textDelta(4, "重新考虑后的思路。"), resultEvent(5, "重新考虑后的思路。", 3),
  ])).toMatchObject([
    { kind: "text", text: "原来的思路。", process: true },
    { kind: "user_message", id: "user-message-run-correction", text: "换个方向", sequence: 2 },
    { kind: "text", text: "重新考虑后的思路。", process: false },
  ]);
});

it("keeps the submitted bubble once while delivery occurs after resumed output", () => {
  expect(buildConversationStream([
    submitted(0, "correction", "换个方向"), turnStarted(1), textDelta(2, "正在重新考虑。"),
    delivered(3, "换个方向", "correction"), textDelta(4, "已经调整。"),
  ])).toMatchObject([
    { kind: "user_message", text: "换个方向", sequence: 0 },
    { kind: "text", text: "正在重新考虑。已经调整。" },
  ]);
});

it("preserves distinct message IDs even when their text is identical", () => {
  const stream = buildConversationStream([
    submitted(0, "first", "继续"), delivered(1, "继续", "first"),
    submitted(2, "second", "继续"), delivered(3, "继续", "second"),
  ]);
  expect(stream).toMatchObject([
    { kind: "user_message", id: "user-message-run-first", sequence: 0 },
    { kind: "user_message", id: "user-message-run-second", sequence: 2 },
  ]);
});

it("renders a legacy delivery as a human reply and breaks tools and assistant text around it", () => {
  const stream = buildConversationStream([
    turnStarted(0), textDelta(1, "暂停前。"), toolStarted("before", 2),
    delivered(3, "补充说明"), toolStarted("after", 4), turnStarted(5), textDelta(6, "重新开始。"),
  ]);
  expect(stream.map(item => item.kind)).toEqual(["text", "tool_group", "user_message", "tool_group", "text"]);
  expect(stream[2]).toMatchObject({ text: "补充说明", id: "user-message-run-delivered-3", sequence: 3 });
  expect(groupsIn(stream).map(group => toolsIn(group).length)).toEqual([1, 1]);
});

it("does not replace an authoritative source report across a human reply", () => {
  const stream = buildConversationStream([
    turnStarted(0), textDelta(1, "需要保留的旧报告。"), submitted(2, "correction", "重新评估"),
    turnStarted(3), textDelta(4, "重新评估的过程。"), resultEvent(5, "旧报告的晚到修订。", 0),
  ]);
  expect(stream).toMatchObject([
    { kind: "text", text: "需要保留的旧报告。" },
    { kind: "user_message", text: "重新评估" },
    { kind: "text", text: "重新评估的过程。" },
    { kind: "text", text: "旧报告的晚到修订。" },
  ]);
});

it("retains the pre-reply paragraph with the legacy result fallback", () => {
  expect(buildConversationStream([
    textDelta(0, "相同正文"), delivered(1, "继续"), textDelta(2, "相同正文"), resultEvent(3, "相同正文\n\n最终段落"),
  ])).toMatchObject([
    { kind: "text", text: "相同正文" },
    { kind: "user_message", text: "继续" },
    { kind: "text", text: "相同正文\n\n最终段落", process: false },
  ]);
});

it("keeps resumed progress provisional after a reply to an older final answer", () => {
  const stream = buildConversationStream([
    resultEvent(0, "先前回答"), submitted(1, "correction", "重新检查"), textDelta(2, "正在检查"),
  ]);
  expect(stream).toMatchObject([
    { kind: "text", text: "先前回答", process: false },
    { kind: "user_message", text: "重新检查" },
    { kind: "text", text: "正在检查", process: true },
  ]);
});

const reasoning = (sequence: number, summary: string): AgentEvent =>
  ({ ...base, id: `reasoning-${sequence}`, sequence, type: "reasoning_summary", summary });
const reasoningItems = (events: AgentEvent[]) => buildConversationStream(events).filter(item => item.kind === "reasoning");

it("streams reasoning fragments into one row with a stable first-fragment identity", () => {
  const fragments = ["I", " should", " ", "check", " the", " lockfile", "."];
  const events = [turnStarted(0), ...fragments.map((fragment, index) => reasoning(index + 1, fragment))];
  for (let length = 2; length <= events.length; length++) {
    expect(reasoningItems(events.slice(0, length))).toEqual([{
      kind: "reasoning", id: "reasoning-reasoning-1", sequence: 1,
      text: fragments.slice(0, length - 1).join(""),
    }]);
  }
});

it("preserves standalone spaces, line breaks, and leading whitespace in reasoning fragments", () => {
  const events = [
    turnStarted(0), reasoning(1, " \n"), reasoning(2, "Check"), reasoning(3, " "),
    reasoning(4, "dependencies"), reasoning(5, "\n\n"), reasoning(6, "Then retry."), reasoning(7, " "),
  ];
  expect(reasoningItems(events.slice(0, 2))).toEqual([]);
  expect(reasoningItems(events)).toEqual([{
    kind: "reasoning", id: "reasoning-reasoning-1", sequence: 1, text: " \nCheck dependencies\n\nThen retry. ",
  }]);
});

it("continues one reasoning row through nondisplay usage, request, and checkpoint telemetry", () => {
  const events: AgentEvent[] = [
    turnStarted(0), reasoning(1, "Check"),
    { ...base, id: "request", sequence: 2, type: "model_request_finished", purpose: "main", durationMs: 20, succeeded: true },
    reasoning(3, " "),
    { ...base, id: "usage", sequence: 4, type: "usage", usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, estimatedUsd: 0 } } as AgentEvent,
    reasoning(5, "the"),
    { ...base, id: "checkpoint", sequence: 6, type: "checkpoint_saved", checkpointId: "checkpoint", reason: "tool_batch" },
    reasoning(7, " "), reasoning(8, "configuration."),
  ];
  expect(buildConversationStream(events)).toEqual([{
    kind: "reasoning", id: "reasoning-reasoning-1", sequence: 1, text: "Check the configuration.",
  }]);
});

it("keeps reasoning fragments separate across assistant turns, tool phases, prose, and human replies", () => {
  const events = [
    turnStarted(0), reasoning(1, "Before tool"), reasoning(2, "."),
    toolStarted("tool", 3), reasoning(4, "While tool runs"), toolFinished("tool", 5), reasoning(6, "After tool"),
    textDelta(7, "Process prose."), reasoning(8, "After prose"),
    turnStarted(9), reasoning(10, "New assistant turn"),
    submitted(11, "human", "调整方向"), reasoning(12, "After reply"), reasoning(13, "."),
  ];
  const stream = buildConversationStream(events);
  expect(stream.map(item => item.kind)).toEqual([
    "reasoning", "tool_group", "reasoning", "reasoning", "text", "reasoning", "reasoning", "user_message", "reasoning",
  ]);
  expect(reasoningItems(events).map(item => item.text)).toEqual([
    "Before tool.", "While tool runs", "After tool", "After prose", "New assistant turn", "After reply.",
  ]);
  expect(stream.find(item => item.kind === "text")).toMatchObject({ text: "Process prose.", process: true });
});

it("does not merge reasoning across run identities or visible retry boundaries", () => {
  const events: AgentEvent[] = [
    reasoning(0, "First run"), { ...reasoning(1, "Other run"), runId: "other" }, reasoning(2, "First run again"),
    { ...base, id: "retry", sequence: 3, type: "provider_retry", attempt: 1, maxAttempts: 2, delayMs: 10, category: "transient", recovery: "retry_request", reason: "超时" },
    reasoning(4, "After retry"),
  ];
  expect(reasoningItems(events).map(item => item.text)).toEqual(["First run", "Other run", "First run again", "After retry"]);
  expect(buildConversationStream(events).map(item => item.kind)).toEqual(["reasoning", "reasoning", "reasoning", "event", "reasoning"]);
});

it("keeps reasoning intact while replacing the streamed source report with one authoritative final answer", () => {
  const stream = buildConversationStream([
    turnStarted(0), reasoning(1, "Inspect"), reasoning(2, " "), reasoning(3, "dependencies."),
    textDelta(4, "候选答案。"), reasoning(5, "Review"), reasoning(6, " "), reasoning(7, "wording."),
    resultEvent(8, "复核后的答案。", 0),
  ]);
  expect(stream).toMatchObject([
    { kind: "reasoning", id: "reasoning-reasoning-1", text: "Inspect dependencies." },
    { kind: "reasoning", id: "reasoning-reasoning-5", text: "Review wording." },
    { kind: "text", text: "复核后的答案。", process: false },
  ]);
});

it("preserves reasoning between the prose and tool calls that surround it", () => {
  const stream = buildConversationStream([
    turnStarted(0), textDelta(1, "先说明。"), reasoning(2, "需要检查依赖。"), toolStarted("before", 3),
    toolFinished("before", 4), reasoning(5, "依赖无误，继续检查日志。"), toolStarted("after", 6),
    turnStarted(7), textDelta(8, "最终答案。"), resultEvent(9, "最终答案。", 7),
  ]);
  expect(stream.map(item => item.kind)).toEqual(["text", "reasoning", "tool_group", "reasoning", "tool_group", "text"]);
  expect(stream[1]).toMatchObject({ id: "reasoning-reasoning-2", text: "需要检查依赖。", sequence: 2 });
  expect(stream[3]).toMatchObject({ text: "依赖无误，继续检查日志。", sequence: 5 });
  expect(stream.at(-1)).toMatchObject({ text: "最终答案。", process: false });
});

it("ignores empty reasoning without breaking adjacent prose or tool groups", () => {
  const stream = buildConversationStream([
    toolStarted("a", 0), reasoning(1, " \n"), toolStarted("b", 2),
    textDelta(3, "第一句。"), reasoning(4, ""), textDelta(5, "第二句。"),
  ]);
  expect(groupsIn(stream)).toHaveLength(1);
  expect(toolsIn(groupsIn(stream)[0]!)).toHaveLength(2);
  expect(stream.filter(item => item.kind === "reasoning")).toEqual([]);
  expect(stream.at(-1)).toMatchObject({ text: "第一句。第二句。" });
});

it("retains ordered reasoning when an authoritative result replaces prose already flushed by it", () => {
  const stream = buildConversationStream([
    turnStarted(0), textDelta(1, "候选答案。"), reasoning(2, "复核措辞。"), resultEvent(3, "经过复核的答案。", 0),
  ]);
  expect(stream).toMatchObject([
    { kind: "reasoning", text: "复核措辞。" },
    { kind: "text", text: "经过复核的答案。", process: false },
  ]);
});

it("preserves reasoning on each side of a human reply without replacing earlier prose", () => {
  const stream = buildConversationStream([
    turnStarted(0), textDelta(1, "原说明。"), reasoning(2, "原来的检查。"), submitted(3, "reply", "换个方向"),
    turnStarted(4), reasoning(5, "新的检查。"), textDelta(6, "新答案。"), resultEvent(7, "新答案。", 4),
  ]);
  expect(stream).toMatchObject([
    { kind: "text", text: "原说明。" }, { kind: "reasoning", text: "原来的检查。" },
    { kind: "user_message", text: "换个方向" }, { kind: "reasoning", text: "新的检查。" },
    { kind: "text", text: "新答案。", process: false },
  ]);
});
