import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "@harness/protocol";
import { captureExactPathInputs, createDefaultToolRegistry, fileWriteDiff, FILE_DIFF_MAX_BYTES, lightweightTools, writeFileTool, type ToolContext } from "@harness/tools";
import { parseDiff } from "../apps/desktop/src/code-changes.js";

const temporary: string[] = [];
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
afterEach(async () => {
  const base = await realpath(tmpdir());
  for (const path of temporary.splice(0)) {
    const rel = relative(base, await realpath(path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe fixture cleanup");
    await rm(path, { recursive: true, force: true });
  }
});
async function workspace(): Promise<ToolContext & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-write-file-")); temporary.push(root);
  const workspacePath = join(root, "workspace"); await mkdir(workspacePath);
  return { root, workspacePath, runId: "write-file-test", grants: [], signal: new AbortController().signal };
}
const output = (result: Awaited<ReturnType<typeof writeFileTool.execute>>) => result.output as Record<string, unknown>;

describe("write_file with actual workspace files", () => {
  it("is registered, allowed by the default profile and retained in modern lightweight tools", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.get("write_file")).toBe(writeFileTool);
    expect(DEFAULT_PROFILE.toolNames).toContain("write_file");
    expect(lightweightTools(registry, ["write_file", "apply_patch"]).map(tool => tool.contract.name)).toEqual(["patch", "write_file"]);
  });

  it("creates missing parents in a non-Git workspace and returns actual UTF-8 write and diff receipts", async () => {
    const context = await workspace(), content = "<html>\n  中文截图\n</html>\n";
    const result = await writeFileTool.execute({ path: "src/nested/界面.html", content }, context);
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(context.workspacePath, "src/nested/界面.html"), "utf8")).toBe(content);
    expect(output(result)).toMatchObject({ written: true, path: "src/nested/界面.html", created: true, changed: true,
      byteLength: Buffer.byteLength(content), sha256: hash(content), added: 3, deleted: 0, diffTruncated: false });
    expect(parseDiff(String(output(result).diff))[0]).toMatchObject({ path: "src/nested/界面.html", added: 3, deleted: 0 });
    expect(await readdir(join(context.workspacePath, "src/nested"))).toEqual(["界面.html"]);
  });

  it("requires explicit overwrite and rejects a stale expected hash without changing the file", async () => {
    const context = await workspace(); await writeFile(join(context.workspacePath, "app.ts"), "old\n");
    for (const input of [{ path: "app.ts", content: "new\n" }, { path: "app.ts", content: "new\n", overwrite: true, expectedSha256: hash("stale") }]) {
      const result = await writeFileTool.execute(input, context);
      expect(result.isError).toBe(true); expect(output(result)).toMatchObject({ written: false, phase: "validation" });
      expect(await readFile(join(context.workspacePath, "app.ts"), "utf8")).toBe("old\n");
    }
    expect(await readdir(context.workspacePath)).toEqual(["app.ts"]);
  });

  it("updates a previously inspected file with a matching hash and preserves unchanged lines in its diff", async () => {
    const context = await workspace(), before = "keep first\nold value\nkeep middle\nkeep last\n", after = before.replace("old value", "new value");
    await writeFile(join(context.workspacePath, "app.ts"), before);
    const result = await writeFileTool.execute({ path: "app.ts", content: after, overwrite: true, expectedSha256: hash(before) }, context);
    expect(result.isError).not.toBe(true);
    expect(output(result)).toMatchObject({ written: true, created: false, added: 1, deleted: 1, beforeSha256: hash(before), sha256: hash(after), diffTruncated: false });
    const diff = parseDiff(String(output(result).diff))[0]!;
    expect(diff.lines.filter(line => line.kind === "context").map(line => line.text)).toEqual(["keep first", "keep middle", "keep last"]);
    expect(diff.lines.filter(line => line.kind === "add").map(line => line.text)).toEqual(["new value"]);
    expect(await readFile(join(context.workspacePath, "app.ts"), "utf8")).toBe(after);
    expect(await readdir(context.workspacePath)).toEqual(["app.ts"]);
  });

  it("reports an unchanged rewrite honestly without manufacturing added or deleted lines", async () => {
    const context = await workspace(); await writeFile(join(context.workspacePath, "same.ts"), "same\n");
    expect(output(await writeFileTool.execute({ path: "same.ts", content: "same\n", overwrite: true }, context)))
      .toMatchObject({ written: true, changed: false, created: false, diff: "", added: 0, deleted: 0 });
  });

  it("refuses traversal, workspace-directory targets and non-text overwrites before writing", async () => {
    const context = await workspace(); await writeFile(join(context.workspacePath, "binary.dat"), Buffer.from([0, 255, 1]));
    for (const input of [{ path: "../outside.ts", content: "outside" }, { path: ".", content: "root" }, { path: "binary.dat", content: "text", overwrite: true }]) {
      const result = await writeFileTool.execute(input, context);
      expect(result.isError).toBe(true); expect(output(result)).toMatchObject({ written: false, phase: "validation" });
    }
    expect(await readFile(join(context.workspacePath, "binary.dat"))).toEqual(Buffer.from([0, 255, 1]));
    expect(await readdir(context.root)).toEqual(["workspace"]);
  });

  it("refuses symlink or junction parents and symlink final targets", async () => {
    const context = await workspace(), outside = join(context.root, "outside"); await mkdir(outside);
    await symlink(outside, join(context.workspacePath, "linked"), process.platform === "win32" ? "junction" : "dir");
    const throughParent = await writeFileTool.execute({ path: "linked/new/deep.ts", content: "unsafe" }, context);
    expect(throughParent.isError).toBe(true); expect(output(throughParent)).toMatchObject({ written: false, phase: "validation" });
    expect(await readdir(outside)).toEqual([]);
    const inside = join(context.workspacePath, "inside"); await mkdir(inside);
    await symlink(inside, join(context.workspacePath, "inside-linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await writeFileTool.execute({ path: "inside-linked/new.ts", content: "unsafe" }, context)).isError).toBe(true);
    expect(await readdir(inside)).toEqual([]);
    if (process.platform !== "win32") {
      await writeFile(join(outside, "old.ts"), "outside original");
      await symlink(join(outside, "old.ts"), join(context.workspacePath, "linked.ts"));
      expect((await writeFileTool.execute({ path: "linked.ts", content: "unsafe", overwrite: true }, context)).isError).toBe(true);
      expect(await readFile(join(outside, "old.ts"), "utf8")).toBe("outside original");
    }
  });

  it("honors a literal path grant and rejects a different path without creating it", async () => {
    const context = await workspace();
    context.grants = [{ toolNames: ["write_file"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write", exactPathInputs: captureExactPathInputs({ path: "allowed.ts" }) }];
    const denied = await writeFileTool.execute({ path: "other.ts", content: "no" }, context);
    expect(denied.isError).toBe(true); expect(output(denied)).toMatchObject({ written: false, phase: "validation" });
    expect(await readdir(context.workspacePath)).toEqual([]);
    expect(output(await writeFileTool.execute({ path: "allowed.ts", content: "yes" }, context))).toMatchObject({ written: true });
  });

  it("does not create output after cancellation or an expected hash for a missing file", async () => {
    const context = await workspace(), controller = new AbortController(); controller.abort();
    expect((await writeFileTool.execute({ path: "cancelled/deep.ts", content: "no" }, { ...context, signal: controller.signal })).isError).toBe(true);
    expect((await writeFileTool.execute({ path: "missing/deep.ts", content: "no", expectedSha256: hash("missing") }, context)).isError).toBe(true);
    expect(await readdir(context.workspacePath)).toEqual([]);
  });

  it("returns bounded Unicode diff output while saving the complete permitted source", async () => {
    const context = await workspace(), content = "中文代码\n".repeat(8_000);
    const result = await writeFileTool.execute({ path: "large.ts", content }, context), receipt = output(result);
    expect(receipt).toMatchObject({ written: true, diffTruncated: true, added: 8_000, deleted: 0 });
    expect(Buffer.byteLength(String(receipt.diff))).toBeLessThanOrEqual(FILE_DIFF_MAX_BYTES);
    expect(String(receipt.diff)).not.toContain("�");
    expect(await readFile(join(context.workspacePath, "large.ts"), "utf8")).toBe(content);
  });
});

describe("bounded exact line diffs", () => {
  it("keeps distant unchanged regions and EOF newline changes accurate", () => {
    const before = "first\none\nmiddle\ntwo\nlast\n", after = "first\nONE\nmiddle\nTWO\nlast\n";
    expect(fileWriteDiff("app.ts", before, after, false)).toMatchObject({ added: 2, deleted: 2, diffTruncated: false });
    expect(fileWriteDiff("app.ts", "last", "last\n", false)).toMatchObject({ added: 1, deleted: 1, diffTruncated: false });
    expect(fileWriteDiff("app.ts", "last", "last\n", false).diff).toContain("\\ No newline at end of file");
  });
  it("does not fabricate complete counts if the comparison budget is exceeded", () => {
    const before = Array.from({ length: 1500 }, (_, i) => `old-${i}\n`).join(""), after = before.replaceAll("old-", "new-");
    const receipt = fileWriteDiff("app.ts", before, after, false);
    expect(receipt.diffTruncated).toBe(true); expect(receipt.added).toBeUndefined(); expect(receipt.deleted).toBeUndefined();
  });
});
