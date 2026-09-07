import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { gitDiffTool, runProcess } from "@harness/tools";

describe("workflow diff evidence", () => {
  it("includes staged and new-file content, and rejects a non-repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-diff-"));
    const context = { runId: "fixture", workspacePath: root, grants: [], signal: new AbortController().signal };
    try {
      expect((await gitDiffTool.execute({}, context)).isError).toBe(true);
      expect((await runProcess("git", ["init"], { cwd: root, signal: context.signal, timeoutMs: 10000 })).exitCode).toBe(0);
      await writeFile(join(root, "staged.ts"), "export const staged = true;\n");
      expect((await runProcess("git", ["add", "staged.ts"], { cwd: root, signal: context.signal, timeoutMs: 10000 })).exitCode).toBe(0);
      await writeFile(join(root, "new.ts"), "export const fresh = true;\n");
      const result = await gitDiffTool.execute({}, context);
      expect(result.isError).toBe(false); expect(result.truncated).toBe(false);
      expect(result.output).toMatchObject({ stagedDiff: expect.stringContaining("export const staged"), newFiles: [{ path: "new.ts", content: "export const fresh = true;\n" }] });
      await writeFile(join(root, "large.txt"), "x".repeat(70000));
      expect((await gitDiffTool.execute({}, context)).truncated).toBe(true);
    } finally {
      const rel = relative(tmpdir(), root); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
});