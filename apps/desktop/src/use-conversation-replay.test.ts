import { expect, it } from "vitest";
import type { AgentEvent } from "@harness/protocol";
import { conversationReplayFrames } from "./use-conversation-replay.js";

it("replays ordered recorded boundaries and includes all intervening text and the final result", () => {
  const base = { runId: "r", at: "2026-10-15T00:00:00Z" };
  const events: AgentEvent[] = [
    { ...base, id: "a", sequence: 0, type: "assistant_turn_started" },
    { ...base, id: "b", sequence: 1, type: "text_delta", delta: "Checking" },
    { ...base, id: "c", sequence: 2, type: "tool_started", call: { id: "call", name: "terminal", input: {} } },
    { ...base, id: "d", sequence: 3, type: "tool_finished", callId: "call", output: "ok", durationMs: 10 },
    { ...base, id: "e", sequence: 4, type: "result", status: "completed", text: "Done" },
  ];
  expect(conversationReplayFrames(events)).toEqual([0, 3, 4, 5]);
  expect(events).toHaveLength(5);
});

it("bounds long replays while retaining the entire final conversation", () => {
  const events = Array.from({ length: 300 }, (_, index): AgentEvent => ({
    runId: "r", at: "2026-10-15T00:00:00Z", id: String(index), sequence: index,
    type: "reasoning_summary", summary: `Step ${index}`,
  }));
  const frames = conversationReplayFrames(events);
  expect(frames.length).toBeLessThanOrEqual(33);
  expect(frames[0]).toBe(0);
  expect(frames.at(-1)).toBe(events.length);
  expect(frames).toEqual([...new Set(frames)].sort((a, b) => a - b));
});
