import { describe, expect, it } from "vitest";
import { defaultConversationLayout } from "./conversation-layout.js";

describe("conversation layout", () => {
  it("keeps process records and code review visible by default", () => {
    expect(defaultConversationLayout).toEqual({
      processExpanded: true,
      reviewExpanded: true,
      inlineReview: true,
    });
  });
});
