import { describe, expect, it } from "vitest";
import { approvalTraceSummary } from "./approval-trace.js";

const request = (input: unknown, name = "probe", risk = "high") => `${name} (${risk}): ${JSON.stringify(input)}`;

describe("approvalTraceSummary", () => {
  it("extracts a root command while keeping stdin out of the title", () => {
    expect(approvalTraceSummary(request({ command: "python3 -", stdin: "print('experiment')" })))
      .toEqual({ toolName: "probe", command: "python3 -", title: "probe · python3 -" });
  });

  it("reads a command in any position of complete root JSON", () => {
    expect(approvalTraceSummary(request({ timeoutMs: 1000, stdin: "script", command: "pnpm test" }, "run_verification")))
      .toEqual({ toolName: "run_verification", command: "pnpm test", title: "run_verification · pnpm test" });
  });

  it("recovers the complete first command when the runtime truncates long stdin", () => {
    const input = JSON.stringify({ command: "python -", stdin: "large script\n".repeat(1000) }).slice(0, 2000);
    expect(approvalTraceSummary(`probe (high): ${input}`))
      .toEqual({ toolName: "probe", command: "python -", title: "probe · python -" });
  });

  it("decodes escaped quotes, backslashes, newlines, and unicode in a truncated prefix", () => {
    const command = "python \"C:\\work\\script.py\"\n--name \u4e2d\u6587";
    const encoded = JSON.stringify(command).replace("中文", "\\u4e2d\\u6587");
    expect(approvalTraceSummary(`probe (high): {"command":${encoded},"stdin":"unfinished`))
      .toEqual({ toolName: "probe", command, title: "probe · python \"C:\\work\\script.py\" --name 中文" });
  });

  it("does not mistake nested or stdin command text for a root command", () => {
    const cases = [
      request({ stdin: '{"command":"fake"}' }),
      request({ options: { command: "nested" } }),
      'probe (high): {"stdin":"a \\"command\\": \\"fake\\"',
      'probe (high): {"stdin":"script","command":"python -"',
      'probe (high): [{"command":"fake"}]',
    ];
    for (const summary of cases) expect(approvalTraceSummary(summary)).toEqual({ toolName: "probe", title: "probe" });
  });

  it("ignores malformed, incomplete, nonstring, and empty command values", () => {
    const inputs = [
      '{"command":"unfinished', '{"command":"bad\\q","stdin":"unfinished',
      '{"command":"python -" trailing', '{"command":"raw\nnewline","stdin":"unfinished',
      '{broken,"command":"fake"}', "null", "[]",
    ];
    for (const input of inputs) expect(approvalTraceSummary(`probe (high): ${input}`))
      .toEqual({ toolName: "probe", title: "probe" });
    for (const command of [null, false, 12, {}, [], "", "  \n\t"]) {
      expect(approvalTraceSummary(request({ command }))).toEqual({ toolName: "probe", title: "probe" });
    }
  });

  it("bounds and compacts long command titles without copying stdin", () => {
    const command = `python -c ${"x".repeat(300)}`;
    const summary = approvalTraceSummary(request({ command, stdin: "sensitive script" }));
    expect(summary.command).toBe(command);
    expect(summary.title.length).toBe(140);
    expect(summary.title.endsWith("…")).toBe(true);
    expect(summary.title).not.toContain("sensitive script");
  });

  it("preserves bounded fallback text for unknown approval formats", () => {
    expect(approvalTraceSummary("需要批准\n  执行工具")).toEqual({ title: "需要批准 执行工具" });
    const fallback = approvalTraceSummary("原始审批 ".repeat(100));
    expect(fallback.title.length).toBeLessThanOrEqual(140);
    expect(fallback.title.endsWith("…")).toBe(true);
    expect(approvalTraceSummary(" \n ")).toEqual({ title: "工具调用" });
  });

  it("recognizes only the runtime risk envelope and preserves the tool identity", () => {
    for (const risk of ["read", "write", "high", "destructive"]) {
      expect(approvalTraceSummary(request({}, "namespace.tool-v2/run", risk)))
        .toEqual({ toolName: "namespace.tool-v2/run", title: "namespace.tool-v2/run" });
    }
    expect(approvalTraceSummary(request({}, "probe", "unknown"))).toEqual({ title: 'probe (unknown): {}' });
    expect(approvalTraceSummary('probe (high extra): {"command":"x"}').toolName).toBeUndefined();
    expect(approvalTraceSummary('probe forged (high): {"command":"x"}').toolName).toBeUndefined();
    expect(approvalTraceSummary(request({ command: "remote command" }, "mcp_abc_terminal_xyz")))
      .toEqual({ toolName: "mcp_abc_terminal_xyz", command: "remote command", title: "mcp_abc_terminal_xyz · remote command" });
  });
});
