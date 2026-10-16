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

  it("extracts names from a Git unified patch used by the tool runtime", () => {
    const patch = "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n";
    expect(toolActivity("apply_patch", { patch })).toEqual({ verb: "编辑了文件", detail: "src/old.ts, src/new.ts" });
  });

  it("summarizes commands and search inputs", () => {
    expect(toolSummary("terminal", { command: "pnpm test" })).toMatchObject({ label: "terminal", detail: "pnpm test", kind: "command" });
    expect(toolSummary("search_text", { query: "ConversationTurnView", path: "apps/desktop/src" })).toMatchObject({ label: "search_text", detail: "ConversationTurnView · apps/desktop/src", kind: "search" });
  });

  it.each(["probe", "run_verification", "bash", "runCommand", "run_command", "exec_command"])("recognizes %s as a local command without exposing stdin", name => {
    expect(toolSummary(name, { command: "python -", stdin: "script contents" }))
      .toEqual({ label: name, detail: "python -", kind: "command" });
  });

  it("falls back safely for unknown or incomplete input", () => {
    expect(toolSummary("mystery", {})).toEqual({ label: "mystery", detail: "", kind: "generic" });
  });

  it("uses activity language for timeline summaries", () => {
    expect(toolActivity("terminal", { command: "pnpm test" })).toEqual({ verb: "已运行", detail: "pnpm test" });
    expect(toolActivity("apply_patch", { patch: "*** Update File: src/app.ts" })).toEqual({ verb: "编辑了文件", detail: "src/app.ts" });
    expect(toolActivity("write_file", { path: "src/app.ts" })).toEqual({ verb: "编辑了文件", detail: "src/app.ts" });
  });

  it("recognizes lightweight patch and search tools in trace rows", () => {
    expect(toolActivity("patch", { patch: "*** Update File: src/app.ts" })).toEqual({ verb: "编辑了文件", detail: "src/app.ts" });
    expect(toolSummary("search_files", { query: "Trace", glob: "**/*.tsx" }).kind).toBe("search");
    expect(toolSummary("web_search", { queries: ["pnpm lockfile", "CI"] })).toEqual({ label: "网页搜索", detail: "pnpm lockfile · CI", kind: "search" });
  });

  it("an MCP tool shows its service and original name instead of the namespaced name", () => {
    const origin = { serverId: "mcp_1", serverName: "项目工具", toolName: "read_project_status", revision: 3 };
    const summary = toolSummary("mcp_a1b2c3d4e5_read_project_status_f6g7h8i9j0", { value: 1 }, origin);
    // The row renders `detail`, not `label` — see renderer.tsx ToolEventRow.
    expect(summary.detail).toBe("项目工具 · read_project_status");
    expect(summary.kind).toBe("generic");
  });

  it("a local tool is unaffected by the origin parameter", () => {
    expect(toolSummary("read_file", { path: "a.ts" }).detail).toBe("a.ts");
    expect(toolSummary("read_file", { path: "a.ts" }, undefined).detail).toBe("a.ts");
  });

  it("origin takes precedence over local tool branches", () => {
    const origin = { serverId: "mcp_1", serverName: "远端", toolName: "terminal", revision: 1 };
    expect(toolSummary("terminal", { command: "x" }, origin).detail).toBe("远端 · terminal");
    expect(toolSummary("probe", { command: "x" }, { ...origin, toolName: "probe" }))
      .toEqual({ label: "probe", detail: "远端 · probe", kind: "generic" });
  });
});
