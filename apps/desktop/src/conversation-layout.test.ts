import { describe, expect, it } from "vitest";
import {
  defaultConversationLayout,
  isAwayFromLatest,
  shouldExpandToolGroup,
  shouldPreviewProcessText,
  shouldShowHistoryLoading,
  summarizeActivityMessage,
} from "./conversation-layout.js";

describe("conversation layout", () => {
  it("keeps process records and code review visible by default", () => {
    expect(defaultConversationLayout).toEqual({
      processExpanded: true,
      reviewExpanded: true,
      inlineReview: true,
    });
  });
});

it("shows the history loading state only for an empty active session", () => {
  expect(shouldShowHistoryLoading(true, true, 0)).toBe(true);
  expect(shouldShowHistoryLoading(true, false, 0)).toBe(false);
  expect(shouldShowHistoryLoading(false, true, 0)).toBe(false);
  expect(shouldShowHistoryLoading(true, true, 1)).toBe(false);
});

it("keeps only unfinished tool groups expanded as runs progress", () => {
  expect(shouldExpandToolGroup(1, 3)).toBe(true);
  expect(shouldExpandToolGroup(3, 3)).toBe(false);
});

it("offers a return to latest only after the reader scrolls away", () => {
  expect(isAwayFromLatest(950, 1_500, 500)).toBe(false);
  expect(isAwayFromLatest(500, 1_500, 500)).toBe(true);
});

it("keeps brief progress visible and previews long process narration", () => {
  expect(shouldPreviewProcessText("正在读取项目配置。 ")).toBe(false);
  expect(shouldPreviewProcessText(`terminal(high): ${"Get-ChildItem -Recurse ".repeat(30)}`)).toBe(true);
  expect(shouldPreviewProcessText(`terminal(high): ${"Get-ChildItem -Recurse ".repeat(30)}`, true)).toBe(false);
});

it("keeps long activity messages readable without losing their full text", () => {
  expect(summarizeActivityMessage("命令失败：权限不足")).toBe("命令失败：权限不足");
  const summary = summarizeActivityMessage(`terminal(high): ${"Get-ChildItem -Recurse ".repeat(30)}`);
  expect(summary.length).toBeLessThan(180);
  expect(summary.endsWith("…")).toBe(true);
});
