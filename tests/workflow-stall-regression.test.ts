import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { pagedReadTool, searchFilesTool, browserTool, readFileTool, runProcess } from "@harness/tools";
import { EncryptedBlobStore, VaultCrypto } from "@harness/persistence";
import { ReadEvidenceCache } from "../packages/core/src/read-evidence-cache.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";
import { WorkspaceDiff } from "../packages/core/src/workspace-diff.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "harness-stall-"));
  try { await run(root); } finally {
    const path = relative(tmpdir(), root);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
}
const context = (root: string) => ({ runId: "r", workspacePath: root, grants: [], signal: new AbortController().signal });

describe("bounded repository evidence", () => {
  it.each(["one\ntwo\n", ""])("retains complete read_file string content and its original evidence ID across unchanged reads (%#)", content => fixture(async root => {
    await writeFile(join(root, "full.txt"), content);
    const call = { id: "original-full-read", name: "read_file", input: { path: "full.txt" } };
    const cache = new ReadEvidenceCache();
    const identity = await cache.identify(call, root);
    const result = await readFileTool.execute(call.input, context(root));
    expect(result).toMatchObject({ output: content, truncated: false });
    cache.remember(identity, call.id, result);
    const repeatedIdentity = await cache.identify({ ...call, id: "repeated-read" }, root);
    const reused = cache.lookup(repeatedIdentity, new Set([call.id]));
    expect(reused).toMatchObject({ truncated: false, output: { reusedEvidenceId: call.id, unchanged: true, content, truncated: false } });
    cache.remember(repeatedIdentity, "repeated-read", reused!);
    expect(cache.lookup(repeatedIdentity)).toMatchObject({ output: { reusedEvidenceId: call.id, content } });
    await writeFile(join(root, "full.txt"), content ? "ONE\ntwo\n" : "x");
    const changedIdentity = await cache.identify(call, root);
    expect(changedIdentity?.digest).not.toBe(identity?.digest);
    expect(cache.lookup(changedIdentity)).toBeUndefined();
  }));
  it("accepts middle pages as range evidence and preserves pagination across cache hits", () => fixture(async root => {
    await writeFile(join(root, "page.txt"), "one\ntwo\nthree\nfour\nfive");
    const call = { id: "page", name: "read_file", input: { path: "page.txt", offset: 2, limit: 2 } };
    const cache = new ReadEvidenceCache();
    const identity = await cache.identify(call, root);
    const result = await pagedReadTool.execute(call.input, context(root));
    expect(result).toMatchObject({ truncated: false, output: { content: "2: two\n3: three", hasMore: true, nextOffset: 4, returnedLines: 2 } });
    cache.remember(identity, call.id, result);
    expect(cache.lookup(identity)).toMatchObject({ truncated: false, output: { reusedEvidenceId: "page", offset: 2, content: "2: two\n3: three", hasMore: true, nextOffset: 4 } });
    const workflow = new SequentialWorkflow("inspect", () => {});
    workflow.advance({ action: "understand", summary: "Inspect requested lines", requirements: ["Inspect requested lines"] });
    workflow.observe(call, result);
    expect(() => workflow.advance({ action: "architecture", summary: "Scoped evidence", evidenceIds: [call.id] })).not.toThrow();
    expect(await pagedReadTool.execute({ ...call.input, offset: 4 }, context(root))).toMatchObject({ truncated: false, output: { hasMore: false } });
    await writeFile(join(root, "page.txt"), "ONE\ntwo\nthree\nfour\nfive");
    expect(cache.lookup(await cache.identify(call, root))).toBeUndefined();
  }));
  it("keeps byte-limited and oversized-line evidence incomplete even when cached", () => fixture(async root => {
    await writeFile(join(root, "large.txt"), "x".repeat(32000) + "\n" + "y".repeat(32000));
    const call = { id: "large", name: "read_file", input: { path: "large.txt", limit: 2 } };
    const cache = new ReadEvidenceCache();
    const identity = await cache.identify(call, root);
    const result = await pagedReadTool.execute(call.input, context(root));
    expect(result.truncated).toBe(true);
    cache.remember(identity, call.id, result);
    expect(cache.lookup(identity)?.truncated).toBe(true);
    await writeFile(join(root, "large.txt"), "x".repeat(65000));
    expect(await pagedReadTool.execute(call.input, context(root))).toMatchObject({ truncated: true, output: { returnedLines: 0, code: "line_exceeds_budget" } });
  }));
  it("separates search pagination from output truncation", () => fixture(async root => {
    await writeFile(join(root, "a.txt"), "a"); await writeFile(join(root, "b.txt"), "b");
    expect(await searchFilesTool.execute({ mode: "name", glob: "*.txt", limit: 1 }, context(root))).toMatchObject({ truncated: false, output: { hasMore: true, nextOffset: 1 } });
    expect(await searchFilesTool.execute({ mode: "name", glob: "*.txt", offset: 1, limit: 1 }, context(root))).toMatchObject({ truncated: false, output: { hasMore: false } });
  }));
  it("returns specific evidence reasons and length guidance without asking for another read", async () => {
    const workflow = new SequentialWorkflow("inspect", () => {});
    workflow.observe({ id: "old", name: "read_file", input: {} }, { output: "old" });
    workflow.advance({ action: "understand", summary: "Inspect", requirements: ["Inspect"] });
    workflow.observe({ id: "large", name: "read_file", input: {} }, { output: "partial", truncated: true });
    const result = await workflow.planningTool().execute({ action: "architecture", summary: "x", evidenceIds: ["missing", "old", "large"] }, context("."));
    expect(result).toMatchObject({ isError: true, output: { evidenceErrors: [{ id: "missing", reason: "missing" }, { id: "large", reason: "output_truncated" }] } });
    expect(await workflow.planningTool().execute({ action: "architecture", summary: "Current source read before understanding is still usable", evidenceIds: ["old"] }, context("."))).not.toHaveProperty("isError", true);
    expect(await workflow.planningTool().execute({ action: "architecture", summary: "x".repeat(3001), evidenceIds: ["large"] }, context("."))).toMatchObject({ output: { code: "workflow_input_invalid", invalidFields: [{ path: "summary", limit: 3000, actual: 3001 }], nextAction: expect.stringContaining("do not require new file reads") } });
  });
  it("does not establish repository-change intent for browser interactions", () => {
    const workflow = new SequentialWorkflow("Open the night page", () => {});
    for (const action of ["navigate", "click", "snapshot", "screenshot"]) expect(workflow.before({ id: action, name: "browser", input: { action } }, browserTool)).toBeUndefined();
    expect(workflow.needsChange).toBe(false);
    expect(workflow.verificationGate("local")).toBeUndefined();
  });
});

describe("non-Git workspace review", () => {
  it("persists a baseline, restores it, and reports text and binary additions/modifications/deletions", () => fixture(async root => {
    const workspace = join(root, "work"); await mkdir(workspace);
    await writeFile(join(workspace, "edit.txt"), "before\n"); await writeFile(join(workspace, "delete.txt"), "removed\n");
    const vault = await VaultCrypto.open(join(root, "vault"), "fixture-password");
    try {
      const blobs = new EncryptedBlobStore(join(root, "blobs"), vault);
      const initial = new WorkspaceDiff(workspace, blobs);
      await initial.prepare(context(workspace).signal);
      expect(initial.reference).toBeDefined();
      await writeFile(join(workspace, "edit.txt"), "after\n"); await rm(join(workspace, "delete.txt"));
      await writeFile(join(workspace, "new.txt"), "new\n"); await writeFile(join(workspace, "image.bin"), Buffer.from([0, 1, 2]));
      const restored = new WorkspaceDiff(workspace, blobs, initial.reference);
      const result = await restored.tool().execute({}, context(workspace));
      expect(result).toMatchObject({ truncated: false, output: { complete: true, files: expect.arrayContaining([
        expect.objectContaining({ path: "edit.txt", status: "modified", diff: expect.stringContaining("-before") }),
        expect.objectContaining({ path: "delete.txt", status: "deleted" }),
        expect.objectContaining({ path: "new.txt", status: "added" }),
        expect.objectContaining({ path: "image.bin", after: expect.objectContaining({ binary: true, size: 3 }) }),
      ]) } });
    } finally { vault.dispose(); }
  }));
  it("does not certify missing historical coverage and fully includes source above the old 64KB limit", () => fixture(async root => {
    const missing = new WorkspaceDiff(root, undefined, undefined, true);
    expect(await missing.tool().execute({}, context(root))).toMatchObject({ truncated: true, output: { code: "baseline_history_missing" } });
    const bounded = new WorkspaceDiff(root); await bounded.prepare(context(root).signal);
    await writeFile(join(root, "large.txt"), "x".repeat(65000));
    const result = await bounded.tool().execute({}, context(root));
    expect(result).toMatchObject({ truncated: false, output: { complete: true } });
    const files = (result.output as { files: Array<{ diff: string }> }).files;
    expect(files.map(file => file.diff).join("")).toContain("x".repeat(65000));
  }));
  it("delegates staged and untracked Git changes to the existing implementation", () => fixture(async root => {
    await runProcess("git", ["init", "-q"], { cwd: root, signal: context(root).signal, timeoutMs: 10000 });
    await writeFile(join(root, "staged.txt"), "staged\n");
    await runProcess("git", ["add", "staged.txt"], { cwd: root, signal: context(root).signal, timeoutMs: 10000 });
    await writeFile(join(root, "new.txt"), "new\n");
    expect(await new WorkspaceDiff(root).tool().execute({}, context(root))).toMatchObject({ isError: false, truncated: false, output: { stagedDiff: expect.stringContaining("+staged"), newFiles: [{ path: "new.txt", content: "new\n" }] } });
  }));
});
