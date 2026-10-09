import { describe, expect, it } from "vitest";
import { assistantMessages, dedupeFinalText, replacesFinalText } from "./assistant-messages.js";
import type { AgentEvent } from "@harness/protocol";

describe("dedupeFinalText", () => {
  it("does not emit a duplicate final result after streamed text", () => {
    expect(dedupeFinalText("你好，世界。", "你好，世界。")).toBe("");
  });

  it("keeps a final result when no stream text exists", () => {
    expect(dedupeFinalText("", "最终答案")).toBe("最终答案");
  });

  it("keeps a distinct final result", () => {
    expect(dedupeFinalText("前置说明", "最终答案")).toBe("最终答案");
  });

  it("preserves an added review status and does not hide substring-related results", () => {
    expect(dedupeFinalText("分析报告", "分析报告\n\n独立审核未完成")).toBe("分析报告\n\n独立审核未完成");
    expect(dedupeFinalText("详细分析报告", "分析报告")).toBe("分析报告");
    expect(replacesFinalText("分析报告", "分析报告\n\n独立审核未完成")).toBe(true);
    expect(replacesFinalText("分析报告", "分析报告修订版")).toBe(false);
    expect(replacesFinalText("详细分析报告", "分析报告")).toBe(false);
  });
});

describe("assistantMessages", () => {
  const base = { runId: "run", at: "2026-10-08T03:55:00Z" };
  const event = (sequence: number, value: object) => ({ ...base, id: `event-${sequence}`, sequence, ...value }) as AgentEvent;

  it("updates the exact source report while retaining an earlier version", () => {
    const events = [
      event(0, { type: "assistant_turn_started" }),
      event(1, { type: "text_delta", delta: "第一版报告" }),
      event(2, { type: "assistant_turn_started" }),
      event(3, { type: "text_delta", delta: "修订报告" }),
      event(4, { type: "result", sourceAssistantTurnSequence: 2, text: "修订报告\n\n独立审核未完成", status: "review" }),
    ];
    expect(assistantMessages(events)).toEqual({ text: "修订报告\n\n独立审核未完成", progress: ["第一版报告"] });
  });

  it("keeps old append-only review status in the final report without copying the original to progress", () => {
    expect(assistantMessages([
      event(0, { type: "assistant_turn_started" }),
      event(1, { type: "text_delta", delta: "报告" }),
      event(2, { type: "result", text: "报告\n\n审核未完成", status: "review" }),
    ])).toEqual({ text: "报告\n\n审核未完成", progress: [] });
  });

  it("does not replace a different run with the same turn sequence", () => {
    expect(assistantMessages([
      event(0, { type: "assistant_turn_started", runId: "earlier" }),
      event(1, { type: "text_delta", runId: "earlier", delta: "早期报告" }),
      event(2, { type: "result", sourceAssistantTurnSequence: 0, text: "当前报告", status: "completed" }),
    ])).toEqual({ text: "当前报告", progress: ["早期报告"] });
  });

  it("uses exact suffix fallback if a preview omitted the source marker", () => {
    expect(assistantMessages([
      event(1, { type: "text_delta", delta: "原报告" }),
      event(2, { type: "result", sourceAssistantTurnSequence: 0, text: "原报告\n\n待复核", status: "review" }),
    ])).toEqual({ text: "原报告\n\n待复核", progress: [] });
  });
});
