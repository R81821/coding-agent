import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunSpecSchema, DEFAULT_PROFILE } from "@harness/protocol";
import { pagedReadTool, searchFilesTool, terminalTool } from "@harness/tools";
import { CodingWorkflow } from "../packages/core/src/coding-workflow.js";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { snapshotWorkspace, compareWorkspace } from "../packages/core/src/workspace-impact.js";
import { todoTool, validateVerificationInput } from "../packages/core/src/runtime-tools.js";

describe("1.4 runtime boundaries", () => {
  it("defaults old incoming requests to auto mode", () => {
    const run = RunSpecSchema.parse({ id: "r", sessionId: "s", request: "Inspect memory", workspacePath: ".", profileId: "p", budget: DEFAULT_PROFILE.budget, createdAt: new Date().toISOString() });
    expect(run.taskMode).toBe("auto");
  });
  it("keeps terminal risk separate from actual repository changes", () => {
    const workflow = new LightweightWorkflow("Inspect memory", () => {}, undefined, {}, "auto");
    const call = { id: "query", name: "terminal", input: { command: "git status --short" } };
    expect(workflow.before(call, terminalTool)).toBeUndefined();
    workflow.starting(call, terminalTool);
    workflow.applyEffect({ kind: "read", changedFiles: [] });
    workflow.observe(call, { output: " M existing.ts" });
    expect(workflow.state.revision).toBe(0);
    expect(workflow.needsChange).toBe(false);
    expect(workflow.checksCurrent()).toBe(true);
  });
  it("detects changes to already dirty files and preserves unchanged evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "impact-"));
    try {
      await writeFile(join(root, "dirty.ts"), "first");
      const first = await snapshotWorkspace(root);
      expect(compareWorkspace(first, await snapshotWorkspace(root)).kind).toBe("read");
      await writeFile(join(root, "dirty.ts"), "other");
      expect(compareWorkspace(first, await snapshotWorkspace(root))).toMatchObject({ kind: "repository_write", changedFiles: ["dirty.ts"] });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
  it("keeps older evidence metadata after 128 observations and prevents todo bypass", async () => {
    const workflow = new LightweightWorkflow("Change memory", () => {}, undefined, {}, "change");
    for (let i = 0; i < 140; i++) workflow.observe({ id: "o" + i, name: "read_file", input: { path: "a.ts" } }, { output: "evidence" });
    expect(workflow.state.observations[0]?.id).toBe("o0");
    const tool = todoTool(workflow);
    const context = { runId: "r", workspacePath: ".", grants: [], signal: new AbortController().signal };
    await tool.execute({ items: [{ id: "a", text: "Make change", status: "pending" }] }, context);
    await tool.execute({ items: [{ id: "a", text: "Make change", status: "completed" }] }, context);
    expect(workflow.state.todos).toHaveLength(1);
    expect(workflow.canFinish()).toBe(false);
  });
  it("rejects empty stdin interpreter checks before execution", () => {
    expect(() => validateVerificationInput({ command: "python -X utf8 -" })).toThrow(/stdin/i);
    expect(validateVerificationInput({ command: "python -", stdin: "print(1)" }).stdin).toBe("print(1)");
  });
  it("keeps an unconfirmed effect until a successful repository recheck", () => {
    const workflow = new LightweightWorkflow("Inspect memory", () => {}, undefined, {}, "auto");
    workflow.applyEffect({ kind: "unknown", changedFiles: [] });
    expect(workflow.state.effect).toBe("unknown");
    expect(workflow.checksCurrent()).toBe(false);
    // An ordinary read must never clear an unconfirmed effect.
    workflow.observe({ id: "read", name: "read_file", input: { path: "a.ts" } }, { output: "evidence" });
    expect(workflow.checksCurrent()).toBe(false);
    // A diff alone cannot establish coverage of skipped or unreadable files.
    workflow.observe({ id: "diff", name: "git_diff", input: {} }, { output: "diff --git a/a.ts b/a.ts" });
    expect(workflow.state.effect).toBe("unknown");
    workflow.applyEffect({ kind: "read", changedFiles: [] });
    expect(workflow.state.effect).toBe("unknown");
    expect(workflow.checksCurrent()).toBe(false);
  });
  it("records an observed difference as a write even when the snapshot is incomplete", () => {
    const before = { files: { "a.ts": "one" }, complete: false, scanned: 2, skipped: 1, truncated: false };
    expect(compareWorkspace(before, { ...before, files: { "a.ts": "two" } })).toMatchObject({ kind: "repository_write", changedFiles: ["a.ts"] });
    expect(compareWorkspace(before, { ...before }).kind).toBe("unknown");
    expect(compareWorkspace(before, { ...before, skipped: 0 }).kind).toBe("unknown");
  });
});

describe("1.4 tool schema contracts and evidence bounds", () => {
  it("never marks a defaulted tool field as required in the schema the model receives", () => {
    const workflow = new LightweightWorkflow("Inspect memory", () => {}, undefined, {}, "auto");
    const contracts = [pagedReadTool.contract, searchFilesTool.contract, todoTool(workflow).contract];
    for (const contract of contracts) {
      const schema = contract.inputSchema as { properties?: Record<string, { default?: unknown }>; required?: string[] };
      const defaulted = Object.keys(schema.properties ?? {}).filter(key => schema.properties?.[key]?.default !== undefined);
      // Output-mode JSON schema would make every defaulted field required and hard-reject the model.
      expect(defaulted.filter(key => (schema.required ?? []).includes(key))).toEqual([]);
    }
    // The documented defaults must survive into the wire schema, and `read_file { path }` must be valid.
    const readSchema = pagedReadTool.contract.inputSchema as { required?: string[]; properties?: Record<string, { default?: unknown }> };
    expect(readSchema.required).toEqual(["path"]);
    expect(Object.keys(readSchema.properties ?? {}).filter(key => readSchema.properties?.[key]?.default !== undefined).sort()).toEqual(["limit", "offset"]);
    const searchSchema = searchFilesTool.contract.inputSchema as { properties?: Record<string, { default?: unknown }> };
    expect(Object.keys(searchSchema.properties ?? {}).filter(key => searchSchema.properties?.[key]?.default !== undefined).sort()).toEqual(["glob", "limit", "mode", "offset"]);
  });
  it("bounds observations for long runs while keeping recent evidence identifiable", () => {
    const modern = new LightweightWorkflow("Change memory", () => {}, undefined, {}, "change");
    for (let i = 0; i < 600; i++) modern.observe({ id: `o${i}`, name: "read_file", input: { path: "a.ts" } }, { output: "evidence" });
    expect(modern.state.observations).toHaveLength(512);
    expect(modern.state.observations[0]?.id).toBe("o88");
    expect(modern.state.observations.at(-1)?.id).toBe("o599");
    // Legacy runs keep the original small sliding window.
    const legacy = new CodingWorkflow("Change memory", () => {});
    for (let i = 0; i < 40; i++) legacy.observe({ id: `l${i}`, name: "read_file", input: { path: "a.ts" } }, { output: "evidence" });
    expect(legacy.state.observations).toHaveLength(32);
  });
});

it("does not mark requirements passed merely because a final answer exists", () => {
 const workflow = new LightweightWorkflow("1. Fix memory\n2. Preserve compatibility", () => {}, undefined, {}, "change");
 Object.assign(workflow.state, { localCheck: { status: "passed", epoch: workflow.state.epoch, revision: 0, runId: "verify", reason: "" }, diffRevision: 0 });
 workflow.observe({ id: "diff", name: "git_diff", input: {} }, { output: "actual changes" });
 workflow.acceptFinalReport("I have completed the task");
 expect(workflow.state.requirementsRevision).toBe(-1);
 expect(workflow.canFinish()).toBe(false);
 expect(workflow.requiresIndependentReview).toBe(false);
 expect(workflow.state.independentReview.status).toBe("skipped");
});
