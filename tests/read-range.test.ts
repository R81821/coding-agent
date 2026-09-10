import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { readFileTool, readRangeTool } from "@harness/tools";

describe("bounded code retrieval", () => {
  it("reads small files normally and directs large files to explicit line ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-range-"));
    const context = { runId: "test", workspacePath: root, grants: [], signal: new AbortController().signal };
    try {
      await writeFile(join(root, "small.ts"), "one\ntwo\nthree\n");
      expect((await readFileTool.execute({ path: "small.ts" }, context)).output).toBe("one\ntwo\nthree\n");
      const range = await readRangeTool.execute({ path: "small.ts", startLine: 2, endLine: 3 }, context);
      expect(range.output).toMatchObject({ content: "2: two\n3: three" });
      await expect(readRangeTool.execute({ path: "../outside", startLine: 1, endLine: 2 }, context)).rejects.toThrow();
      await expect(readRangeTool.execute({ path: "small.ts", startLine: 3, endLine: 2 }, context)).rejects.toThrow();
      await writeFile(join(root, "large.ts"), "content\n".repeat(30000));
      const large = await readFileTool.execute({ path: "large.ts" }, context);
      expect(large.truncated).toBe(true);
      expect(JSON.stringify(large.output).length).toBeLessThan(20000);
      expect(JSON.stringify(large.output)).toContain("read_range");
    } finally { const target = relative(tmpdir(), root); if (!target || target.startsWith("..") || isAbsolute(target)) throw Error("unsafe cleanup"); await rm(root, { recursive: true, force: true }); }
  });
});
