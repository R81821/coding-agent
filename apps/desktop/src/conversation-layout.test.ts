import { describe, expect, it } from "vitest";
import { defaultConversationLayout, shouldShowHistoryLoading } from "./conversation-layout.js";

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
