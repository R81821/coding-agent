import { describe, expect, it } from "vitest";
import { dedupeFinalText } from "./assistant-messages.js";

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
});
