import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { terminalTool } from "@harness/tools";

const context = () => ({ runId: "stdin-probe", workspacePath: tmpdir(), grants: [], signal: new AbortController().signal });
const command = process.platform === "win32" ? "& '" + process.execPath.replaceAll("'", "''") + "' -" : "'" + process.execPath.replaceAll("'", "'\"'\"'") + "' -";
describe("terminal script standard input", () => {
  it("preserves embedded quotes, empty strings and Unicode through the real shell", async () => {
    const result = await terminalTool.execute({ command, stdin: `const value = {text: "中文", empty: "", quote: '"'};
console.log(JSON.stringify(value));
` }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.output as {stdout:string}).stdout.trim())).toEqual({ text: "中文", empty: "", quote: '"' });
  });
  it("preserves failure exit status for script input", async () => {
    const result = await terminalTool.execute({ command, stdin: 'console.error("probe failed"); process.exit(7);' }, context());
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ exitCode: process.platform === "win32" ? 1 : 7, stderr: expect.stringContaining("probe failed") });
  });
  it("includes script input in destructive risk assessment", () => {
    expect(terminalTool.assessRisk?.({ command, stdin: 'Remove-Item -Recurse -Force ./data' })).toBe("destructive");
  });
});
