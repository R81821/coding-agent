import { expect, it } from "vitest";
import { buildConversationStream, type ConversationStreamItem } from "./conversation-stream.js";
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
