import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchTool } from "../packages/tools/src/builtins.js";
import { validatePatchPaths } from "../packages/tools/src/patch-validation.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "harness-patch-"));
  temporary.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  execFileSync("git", ["init", "--quiet"], { cwd: workspacePath });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspacePath });
  return { root, workspacePath, runId: "patch-test", grants: [], signal: new AbortController().signal };
}

describe("applyPatchTool with real git apply", () => {
  it("creates, edits, and deletes a file with standard null sentinels", async () => {
    const context = await repository();
    await applyPatchTool.execute({ patch: "--- /dev/null\n+++ b/probe.txt\n@@ -0,0 +1 @@\n+probe\n" }, context);
    expect(await readFile(join(context.workspacePath, "probe.txt"), "utf8")).toBe("probe\n");
    await applyPatchTool.execute({ patch: "--- a/probe.txt\n+++ b/probe.txt\n@@ -1 +1 @@\n-probe\n+updated\n" }, context);
    expect(await readFile(join(context.workspacePath, "probe.txt"), "utf8")).toBe("updated\n");
    await applyPatchTool.execute({ patch: "--- a/probe.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-updated\n" }, context);
    await expect(readFile(join(context.workspacePath, "probe.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows parent-relative imports in file content", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "module.ts"), "old\n");
    await applyPatchTool.execute({ patch: "--- a/module.ts\n+++ b/module.ts\n@@ -1 +1 @@\n-old\n+import '../module.js';\n" }, context);
    expect(await readFile(join(context.workspacePath, "module.ts"), "utf8")).toBe("import '../module.js';\n");
  });
});


const newFile = (path: string) => `--- /dev/null\n+++ ${path}\n@@ -0,0 +1 @@\n+probe\n`;

describe("validatePatchPaths", () => {
  it.each([
    newFile("b/probe.txt"),
    newFile("b/file with spaces.txt"),
    newFile('"b/file with spaces.txt"'),
    "--- a/probe.txt\t2026-09-09 00:00:00\n+++ /dev/null\n@@ -1 +0,0 @@\n-probe\n",
    'diff --git "a/old name.txt" "b/new name.txt"\nsimilarity index 100%\nrename from "old name.txt"\nrename to "new name.txt"\n',
    "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\ncopy from old name.txt\ncopy to new name.txt\n",
    "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n--- ../ordinary content\n+++ ../ordinary content\n"
  ])("accepts safe paths and only interprets metadata outside hunks (%#)", patch => {
    expect(() => validatePatchPaths(patch)).not.toThrow();
  });

  it.each([
    "/dev/null/child", "/absolute.txt", "C:/outside.txt", "C:\\outside.txt", "C:outside.txt",
    "\\\\server\\share.txt", "//server/share.txt", "b/../outside.txt", "b/..\\outside.txt",
    "b/folder/../../outside.txt", "b/C:/outside.txt", '"b/../outside file.txt"',
    '"b/\\056\\056/outside.txt"', '"b/..\\134outside.txt"', '"b/\\057outside.txt"',
    '"b/\\000file.txt"', '"b/unterminated.txt', '"b/name.txt" trailing', '"b/\\x2e.txt"'
  ])("rejects unsafe or unparseable target %s", path => {
    expect(() => validatePatchPaths(newFile(path))).toThrow();
  });

  it.each([
    "--- /dev/null\n+++ /dev/null\n",
    "--- /dev/null\n",
    "+++ b/file.txt\n",
    "diff --git /dev/null b/file.txt\n",
    "diff --git a/safe.txt b/../outside.txt\n",
    'diff --git "a/safe.txt" "b/..\\134outside.txt"\n',
    "diff --git a/one b/two b/three\n",
    'diff --git "a/file" "b/file" unexpected\n',
    "diff --git a/file.txt b/file.txt\nrename from ../outside.txt\nrename to file.txt\n",
    "diff --git a/file.txt b/file.txt\nrename from file.txt\nrename to C:/outside.txt\n",
    "diff --git a/file.txt b/file.txt\ncopy from \\\\server\\share.txt\ncopy to file.txt\n",
    'diff --git a/file.txt b/file.txt\ncopy from file.txt\ncopy to "..\\134outside.txt"\n',
    "diff --git a/file.txt b/file.txt\nrename from /dev/null\nrename to file.txt\n"
  ])("rejects unsafe or incomplete metadata (%#)", patch => {
    expect(() => validatePatchPaths(patch)).toThrow();
  });
});

describe("Git path and syntax defenses", () => {
  it.each([false, true])("applies Git-generated patches for space paths (quoted=%s)", async quoted => {
    const context = await repository();
    const filename = "file with spaces.txt";
    await writeFile(join(context.workspacePath, filename), "before\n");
    execFileSync("git", ["add", "--", filename], { cwd: context.workspacePath });
    await writeFile(join(context.workspacePath, filename), "after\n");
    let patch = execFileSync("git", ["diff", "--"], { cwd: context.workspacePath, encoding: "utf8" });
    await writeFile(join(context.workspacePath, filename), "before\n");
    if (quoted) {
      patch = patch.replace("diff --git a/file with spaces.txt b/file with spaces.txt", 'diff --git "a/file with spaces.txt" "b/file with spaces.txt"')
        .replace("--- a/file with spaces.txt", '--- "a/file with spaces.txt"')
        .replace("+++ b/file with spaces.txt", '+++ "b/file with spaces.txt"');
    }
    await applyPatchTool.execute({ patch }, context);
    expect(await readFile(join(context.workspacePath, filename), "utf8")).toBe("after\n");
  });

  it("refuses traversal without changing an adjacent file", async () => {
    const context = await repository();
    const outside = join(context.root, "outside.txt");
    await writeFile(outside, "untouched\n");
    await expect(applyPatchTool.execute({ patch: "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-untouched\n+changed\n" }, context)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
  });

  it("keeps git apply --check atomic when a later hunk does not match", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "existing.txt"), "untouched\n");
    const patch = newFile("b/new.txt") + "--- a/existing.txt\n+++ b/existing.txt\n@@ -1 +1 @@\n-wrong\n+changed\n";
    await expect(applyPatchTool.execute({ patch }, context)).rejects.toThrow(/Patch validation failed/);
    await expect(readFile(join(context.workspacePath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(context.workspacePath, "existing.txt"), "utf8")).toBe("untouched\n");
  });
});

describe("Git rename and copy metadata", () => {
  it.each(["rename", "copy"])("applies a safe %s with space paths", async operation => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "old name.txt"), "kept\n");
    const patch = `diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\n${operation} from old name.txt\n${operation} to new name.txt\n`;
    await applyPatchTool.execute({ patch }, context);
    expect(await readFile(join(context.workspacePath, "new name.txt"), "utf8")).toBe("kept\n");
    if (operation === "copy") expect(await readFile(join(context.workspacePath, "old name.txt"), "utf8")).toBe("kept\n");
    else await expect(readFile(join(context.workspacePath, "old name.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["rename", "copy"])("rejects escaping %s metadata before changing any files", async operation => {
    const context = await repository();
    const source = join(context.workspacePath, "safe.txt");
    const target = join(context.root, "escaped.txt");
    await writeFile(source, "kept\n");
    const patch = `diff --git a/safe.txt b/safe.txt\nsimilarity index 100%\n${operation} from safe.txt\n${operation} to ../escaped.txt\n`;
    await expect(applyPatchTool.execute({ patch }, context)).rejects.toThrow(/parent-traversing path/);
    expect(await readFile(source, "utf8")).toBe("kept\n");
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
