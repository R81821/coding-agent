import { describe, expect, it } from "vitest";
import { shouldSubmitComposerKey } from "../apps/desktop/src/composer-keys.js";

describe("desktop composer keyboard behavior", () => {
  it("sends on Enter", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("keeps Shift+Enter as a newline and does not interrupt IME composition", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});
