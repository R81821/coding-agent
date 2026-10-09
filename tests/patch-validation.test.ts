import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchTool } from "../packages/tools/src/builtins.js";
import { prepareUnifiedPatch, validatePatchPaths } from "../packages/tools/src/patch-validation.js";

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
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      applied: false, phase: "validation", diagnostic: { kind: "conflict", paths: ["new.txt", "existing.txt"], retry: "refresh_changed_context" }
    } });
    await expect(readFile(join(context.workspacePath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(context.workspacePath, "existing.txt"), "utf8")).toBe("untouched\n");
  });
});

describe("model patch format recovery without fuzzy application", () => {
  it("replays the actual rain patch whose second hunk advertised 15 added lines instead of 17", async () => {
    const context = await repository();
    const patch = await readFile(new URL("fixtures/rain-hunk-count.patch", import.meta.url), "utf8");
    // Preserve the actual source positions without carrying an unrelated 450-line HTML fixture.
    const original = Array.from({ length: 450 }, (_, index) => `unchanged ${index + 1}`);
    let cursor = 0;
    for (const line of patch.split("\n")) {
      const header = /^@@ -(\d+)/.exec(line);
      if (header) cursor = Number(header[1]) - 1;
      else if (line.startsWith("-") && !line.startsWith("--- ")) original[cursor++] = line.slice(1);
    }
    const filename = join(context.workspacePath, "pelican-bike.html");
    await writeFile(filename, original.join("\n") + "\n");
    // The original command reproduces the observed failure, before the tool's safe recount.
    expect(() => execFileSync("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: context.workspacePath, input: patch, stdio: "pipe" })).toThrow(/patch fragment without header/);
    const result = await applyPatchTool.execute({ patch }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ output: { applied: true, normalizedHunkCounts: true } });
    const updated = (await readFile(filename, "utf8")).split("\n");
    expect(updated.slice(86, 96).join("\n")).toContain("@keyframes rainfallNear");
    expect(updated.filter(line => line.includes("unchanged "))).toEqual(original.filter(line => line.includes("unchanged ")));
    expect(updated.filter(line => line.includes('class="rain'))).toHaveLength(3);
    expect(updated.filter(line => line.includes("<pattern id="))).toHaveLength(3);
  });

  it("recounts both short and oversized hunk lengths while retaining every context line", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "data.txt"), "first\nold\nlast\n");
    const patch = "--- a/data.txt\n+++ b/data.txt\n@@ -1,1 +1,9 @@\n first\n-old\n+new\n last\n";
    const prepared = prepareUnifiedPatch(patch);
    expect(prepared.patch).toBe(patch.replace("-1,1 +1,9", "-1,3 +1,3"));
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ output: { applied: true } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe("first\nnew\nlast\n");
  });

  it.each([
    { before: "first\nlast\n", hunk: "@@ -1,0 +9,8 @@\n+middle\n", after: "first\nmiddle\nlast\n" },
    { before: "first\nold\nlast\n", hunk: "@@ -2,9 +1,0 @@\n-old\n", after: "first\nlast\n" },
    { before: "old", hunk: "@@ -1,8 +1,9 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n", after: "new" }
  ])("keeps insertion, deletion, and no-newline boundaries correct (%#)", async ({ before, hunk, after }) => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "data.txt"), before);
    const result = await applyPatchTool.execute({ patch: `--- a/data.txt\n+++ b/data.txt\n${hunk}` }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ output: { applied: true } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe(after);
  });

  it("validates every file before applying a corrected earlier hunk", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "one.txt"), "old\n");
    await writeFile(join(context.workspacePath, "two.txt"), "untouched\n");
    const patch = "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1,4 +1,9 @@\n-old\n+new\n"
      + "diff --git a/two.txt b/two.txt\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-wrong\n+changed\n";
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      phase: "validation", applied: false, diagnostic: { kind: "conflict", normalizedHunkCounts: true }
    } });
    expect(await readFile(join(context.workspacePath, "one.txt"), "utf8")).toBe("old\n");
    expect(await readFile(join(context.workspacePath, "two.txt"), "utf8")).toBe("untouched\n");
  });

  it.each([
    "@@ -1 +1 @@\n-old\n+new\n",
    "--- a/data.txt\n@@ -1 +1 @@\n-old\n+new\n",
    "--- a/data.txt\n+++ b/data.txt\n@@ -1 +1 @@\n",
    "--- a/data.txt\n+++ b/data.txt\n@@ -1 +1 @@\nold\n+new\n",
    "--- a/data.txt\n+++ b/data.txt\n@@ invalid @@\n-old\n+new\n",
    "--- a/data.txt\n+++ b/data.txt\n@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n"
  ])("returns reusable format diagnostics for genuine malformed input (%#)", async patch => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "data.txt"), "old\n");
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      applied: false, phase: "validation", diagnostic: { kind: "format", retry: "correct_patch", normalizedHunkCounts: false }
    } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe("old\n");
  });

  it.each([
    "--- a/data.txt\n+++ b/data.txt\n@@ -1 +1 @@\n-old\n+new\n",
    "--- a/data.txt\n+++ b/data.txt\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n"
  ])("rejects exact content at a shifted source position instead of guessing a match (%#)", async patch => {
    const context = await repository();
    const original = "prefix\nfirst\nold\nlast\n";
    await writeFile(join(context.workspacePath, "data.txt"), original);
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      applied: false, phase: "validation", diagnostic: { kind: "conflict", paths: ["data.txt"], retry: "refresh_changed_context" }
    } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe(original);
  });

  it("does not ignore real whitespace or a missing source line while recounting", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "data.txt"), "old \n");
    const patch = "--- a/data.txt\n+++ b/data.txt\n@@ -1,7 +1,9 @@\n-old\n+new\n";
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      applied: false, phase: "validation", diagnostic: { kind: "conflict", normalizedHunkCounts: true }
    } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe("old \n");
  });

  it("preserves header-looking source text rather than interpreting it as target metadata", async () => {
    const context = await repository();
    await writeFile(join(context.workspacePath, "data.txt"), "-- ../ordinary content\n");
    const patch = "--- a/data.txt\n+++ b/data.txt\n@@ -1,5 +1,9 @@\n--- ../ordinary content\n+++ ../ordinary content\n";
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ output: { applied: true } });
    expect(await readFile(join(context.workspacePath, "data.txt"), "utf8")).toBe("++ ../ordinary content\n");
  });

  it("rejects ambiguous plain file boundaries instead of hiding missing hunk content", async () => {
    const patch = "--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const context = await repository();
    await writeFile(join(context.workspacePath, "one.txt"), "old\n");
    await writeFile(join(context.workspacePath, "two.txt"), "old\n");
    await expect(applyPatchTool.execute({ patch }, context)).resolves.toMatchObject({ isError: true, output: {
      diagnostic: { kind: "format", retry: "correct_patch" }
    } });
    expect(await readFile(join(context.workspacePath, "one.txt"), "utf8")).toBe("old\n");
    expect(await readFile(join(context.workspacePath, "two.txt"), "utf8")).toBe("old\n");
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
