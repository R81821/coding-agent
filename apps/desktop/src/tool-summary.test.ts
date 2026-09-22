import { describe, expect, it } from "vitest";
import { toolActivity, toolSummary } from "./tool-summary.js";

describe("toolSummary", () => {
  it("summarizes file tools with a file name", () => {
    expect(toolSummary("read_file", { path: "apps/desktop/src/renderer.tsx" })).toEqual({
      label: "read_file",
      detail: "apps/desktop/src/renderer.tsx",
      kind: "file",
    });
  });

  it("extracts changed files from an apply patch", () => {
    expect(toolSummary("apply_patch", { patch: "*** Update File: apps/desktop/src/renderer.tsx\n*** Add File: apps/desktop/src/tool-summary.ts" })).toEqual({
      label: "apply_patch",
      detail: "apps/desktop/src/renderer.tsx, apps/desktop/src/tool-summary.ts",
      kind: "file",
    });
  });

  it("summarizes commands and search inputs", () => {
    expect(toolSummary("terminal", { command: "pnpm test" })).toMatchObject({ label: "terminal", detail: "pnpm test", kind: "command" });
    expect(toolSummary("search_text", { query: "ConversationTurnView", path: "apps/desktop/src" })).toMatchObject({ label: "search_text", detail: "ConversationTurnView · apps/desktop/src", kind: "search" });
  });

  it("falls back safely for unknown or incomplete input", () => {
    expect(toolSummary("mystery", {})).toEqual({ label: "mystery", detail: "", kind: "generic" });
  });

  it("uses activity language for timeline summaries", () => {
    expect(toolActivity("terminal", { command: "pnpm test" })).toEqual({ verb: "已运行", detail: "pnpm test" });
    expect(toolActivity("apply_patch", { patch: "*** Update File: src/app.ts" })).toEqual({ verb: "编辑了文件", detail: "src/app.ts" });
  });
});
