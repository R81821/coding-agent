import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedBlobStore, VaultCrypto } from "@harness/persistence";
import { WorkspaceDiff } from "../packages/core/src/workspace-diff.js";

interface Page {
  files: Array<{ path: string; status: string; diff?: string; complete: boolean; before?: { hash: string; size: number; binary: boolean }; after?: { hash: string; size: number; binary: boolean } }>;
  complete: boolean;
  hasMore: boolean;
  nextCursor?: string;
  code?: string;
  summary: { changedFiles: number; totalParts: number; coveredParts: number; pagesRead: number; manifestDigest: string };
  scope: { excludedDirectories: string[] };
}
const context = (root: string) => ({ runId: "diff-regression", workspacePath: root, grants: [], signal: new AbortController().signal });
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
async function fixture(run: (workspace: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-diff-"));
  const workspace = join(root, "work");
  await mkdir(workspace);
  try { await run(workspace, root); }
  finally {
    const within = relative(tmpdir(), root);
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
async function allPages(diff: WorkspaceDiff, root: string) {
  const pages: Page[] = [];
  let input: Record<string, unknown> = {};
  for (let calls = 0; calls < 300; calls++) {
    const result = await diff.tool().execute(input, context(root));
    expect(result.isError).not.toBe(true);
    // A page also remains below the bridge's larger bounded workspace-diff envelope.
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(80_000);
    const page = result.output as Page;
    pages.push(page);
    expect(result.truncated).toBe(!page.complete);
    if (!page.hasMore) return pages;
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBeTruthy();
    input = { cursor: page.nextCursor };
  }
  throw new Error("Workspace diff pagination did not terminate");
}

describe("non-Git workspace diff coverage", () => {
  it("captures non-Git changes when Git is not installed", () => fixture(async root => {
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
      await writeFile(join(root, "source.ts"), "export const worksWithoutGit = true;\n");
      expect(await diff.tool().execute({}, context(root))).toMatchObject({ truncated: false, output: { complete: true, files: [expect.objectContaining({ path: "source.ts", status: "added" })] } });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }));

  it("includes ordinary files with special object keys or generated-directory names", () => fixture(async root => {
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    await writeFile(join(root, "__proto__"), "prototype content");
    await writeFile(join(root, "constructor"), "constructor content");
    await writeFile(join(root, "build"), "source file named build");
    const pages = await allPages(diff, root);
    expect(pages.at(-1)!.complete).toBe(true);
    expect(pages.flatMap(page => page.files)).toEqual(expect.arrayContaining(["__proto__", "constructor", "build"].map(path => expect.objectContaining({ path, status: "added", complete: true }))));
  }));

  it("reviews the complete text side of binary/text conversions", () => fixture(async root => {
    await writeFile(join(root, "to-source.ts"), Buffer.from([0, 255]));
    await writeFile(join(root, "to-binary.ts"), "export const removedSource = true;\n");
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    await writeFile(join(root, "to-source.ts"), "export const addedSource = true;\n");
    await writeFile(join(root, "to-binary.ts"), Buffer.from([0, 128]));
    const pages = await allPages(diff, root);
    expect(pages.at(-1)!.complete).toBe(true);
    expect(pages.flatMap(page => page.files)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "to-source.ts", diff: expect.stringContaining("+export const addedSource = true;") }),
      expect.objectContaining({ path: "to-binary.ts", diff: expect.stringContaining("-export const removedSource = true;") }),
    ]));
  }));

  it("reviews an empty directory becoming a project without dependency/build or binary output exhausting source coverage", () => fixture(async root => {
    const diff = new WorkspaceDiff(root);
    await diff.prepare(context(root).signal);
    await mkdir(join(root, "src")); await mkdir(join(root, "node_modules")); await mkdir(join(root, "dist"));
    await mkdir(join(root, "public")); await mkdir(join(root, "screenshots"));
    await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(join(root, "node_modules", `${index}.js`), "vendor".repeat(5000))));
    await writeFile(join(root, "dist", "bundle.js"), "generated".repeat(100_000));
    await writeFile(join(root, "package.json"), '{"name":"dashboard","scripts":{"test":"vitest"}}\n');
    const source = Array.from({ length: 8 }, (_, i) => `export const agent${i} = "${"动态图表\\\"".repeat(5000)}";\n`).join("");
    await writeFile(join(root, "src", "dashboard.ts"), source);
    await writeFile(join(root, "public", "font.woff2"), Buffer.alloc(2_000_000, 0));
    await writeFile(join(root, "screenshots", "dashboard.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
    const pages = await allPages(diff, root);
    expect(pages.length).toBeGreaterThan(2);
    const final = pages.at(-1)!;
    expect(final.complete).toBe(true);
    expect(final.summary.changedFiles).toBe(4);
    expect(final.summary.coveredParts).toBe(final.summary.totalParts);
    expect(final.summary.pagesRead).toBe(pages.length);
    expect(final.scope.excludedDirectories).toEqual(expect.arrayContaining(["node_modules", "dist", ".git"]));
    const entries = pages.flatMap(page => page.files);
    expect(new Set(entries.map(file => file.path))).toEqual(new Set(["package.json", "public/font.woff2", "screenshots/dashboard.png", "src/dashboard.ts"]));
    expect(entries.find(file => file.path === "public/font.woff2")).toMatchObject({ complete: true, after: { hash: hash(Buffer.alloc(2_000_000, 0)), size: 2_000_000, binary: true } });
    const actual = entries.filter(file => file.path === "src/dashboard.ts").map(file => file.diff).join("");
    expect(actual).toBe("--- /dev/null\n+++ src/dashboard.ts\n-\n" + source.split("\n").map(line => "+" + line).join("\n"));
    expect(new Set(pages.map(page => page.summary.manifestDigest)).size).toBe(1);
  }));

  it("persists large original text outside the inline baseline budget and reviews its complete modification after restart", () => fixture(async (root, storage) => {
    const vault = await VaultCrypto.open(join(storage, "vault"), "workspace-diff-test");
    try {
      const blobs = new EncryptedBlobStore(join(storage, "blobs"), vault);
      const oldText = "old-source\n".repeat(50_000);
      await writeFile(join(root, "large.ts"), oldText);
      const original = new WorkspaceDiff(root, blobs);
      await original.prepare(context(root).signal);
      const saved = JSON.parse((await blobs.read(original.reference!)).toString("utf8"));
      expect(saved.files["large.ts"].text).toBeUndefined();
      expect(saved.files["large.ts"].textRef.sha256).toBe(hash(oldText));
      const currentText = "new-source\n".repeat(55_000);
      await writeFile(join(root, "large.ts"), currentText);
      const restored = new WorkspaceDiff(root, blobs, original.reference);
      const pages = await allPages(restored, root);
      expect(pages.at(-1)!.complete).toBe(true);
      const actual = pages.flatMap(page => page.files).map(file => file.diff).join("");
      expect(actual).toBe("--- large.ts\n+++ large.ts\n" + oldText.split("\n").map(line => "-" + line).join("\n") + "\n" + currentText.split("\n").map(line => "+" + line).join("\n"));
    } finally { vault.dispose(); }
  }));

  it("cannot jump to a forged final page or accept stale pages after source changes", () => fixture(async root => {
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    await writeFile(join(root, "large.ts"), "export const source = true;\n".repeat(10_000));
    const first = await diff.tool().execute({}, context(root));
    const page = first.output as Page;
    expect(first.truncated).toBe(true);
    expect(await diff.tool().execute({ cursor: page.nextCursor + "forged" }, context(root))).toMatchObject({ isError: true, truncated: true, output: { complete: false, code: "diff_cursor_invalid" } });
    await writeFile(join(root, "late.ts"), "export const late = true;\n");
    expect(await diff.tool().execute({ cursor: page.nextCursor }, context(root))).toMatchObject({ isError: true, truncated: true, output: { complete: false, code: "diff_snapshot_changed" } });
    const pages = await allPages(diff, root);
    expect(pages.at(-1)).toMatchObject({ complete: true, summary: { changedFiles: 2 } });
    expect(pages.flatMap(item => item.files).some(file => file.path === "late.ts")).toBe(true);
  }));

  it("keeps unreadable historical source bodies and missing historical baselines incomplete", () => fixture(async (root, storage) => {
    const vault = await VaultCrypto.open(join(storage, "vault"), "workspace-diff-test");
    try {
      const blobs = new EncryptedBlobStore(join(storage, "blobs"), vault);
      await writeFile(join(root, "old.ts"), "current source");
      const reference = await blobs.put({ bytes: Buffer.from(JSON.stringify({ files: { "old.ts": { hash: hash("old source"), size: 10, binary: false } }, complete: true, missingHistory: false })), mimeType: "application/json", source: "file" });
      const missingBody = await allPages(new WorkspaceDiff(root, blobs, reference), root);
      expect(missingBody.at(-1)).toMatchObject({ complete: false, code: "diff_coverage_incomplete", files: [expect.objectContaining({ path: "old.ts", complete: false })] });
      const noStore = await new WorkspaceDiff(root, undefined, reference).tool().execute({}, context(root));
      expect(noStore).toMatchObject({ truncated: true, output: { complete: false, code: "baseline_history_missing" } });
      const invalidReference = await blobs.put({ bytes: Buffer.from("{}"), mimeType: "application/json", source: "file" });
      expect(await new WorkspaceDiff(root, blobs, invalidReference).tool().execute({}, context(root))).toMatchObject({ truncated: true, output: { complete: false, code: "baseline_history_missing" } });
    } finally { vault.dispose(); }
  }));

  it("rejects a baseline from another workspace instead of silently certifying a new baseline", () => fixture(async (root, storage) => {
    const vault = await VaultCrypto.open(join(storage, "vault"), "workspace-diff-test");
    try {
      const blobs = new EncryptedBlobStore(join(storage, "blobs"), vault);
      await writeFile(join(root, "original.ts"), "old");
      const original = new WorkspaceDiff(root, blobs); await original.prepare(context(root).signal);
      const other = join(storage, "other"); await mkdir(other); await writeFile(join(other, "different.ts"), "current");
      expect(await new WorkspaceDiff(other, blobs, original.reference).tool().execute({}, context(other))).toMatchObject({ truncated: true, output: { complete: false, code: "baseline_history_missing" } });
      expect(await readFile(join(root, "original.ts"), "utf8")).toBe("old");
    } finally { vault.dispose(); }
  }));

  it("does not certify skipped oversized source files even when the rest of the pages are read", () => fixture(async root => {
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    const file = await open(join(root, "unscanned.ts"), "w");
    try { await file.truncate(64_000_001); } finally { await file.close(); }
    expect(await diff.tool().execute({}, context(root))).toMatchObject({ truncated: true, output: { complete: false, code: "diff_coverage_incomplete" } });
  }));
});
