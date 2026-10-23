import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ContentPart, ContextAdjustment, ModelRequest } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";
import { WorkspaceDiff } from "../packages/core/src/workspace-diff.js";

const MIDDLE = "SOURCE_MIDDLE_AFTER_8K_MARKER";
const TAIL = "SOURCE_TAIL_AFTER_8K_MARKER";
const source = "a".repeat(12_000) + MIDDLE + "b".repeat(12_000) + TAIL + "c".repeat(6_000);
const page = (body = source) => ({ source: "workspace_baseline", files: [{ path: "src/room.tsx", diff: body }], complete: true, hasMore: false, summary: { coveredParts: 1, pagesRead: 1 } });
type ResultPart = Extract<ContentPart, { type: "tool_result" }>;
const resultParts = (request: ModelRequest) => request.messages.flatMap(message => message.content).filter((part): part is ResultPart => part.type === "tool_result");
const tool = (name: string): ToolDefinition => ({
  contract: { name, description: "Fixture read", inputSchema: { type: "object" }, risk: "read", idempotent: true, timeoutMs: 1000 },
  execute: async () => ({ output: null }),
});

async function throughBridge(output: unknown, name = "workspace_diff") {
  const requests: ModelRequest[] = [];
  const adjustments: ContextAdjustment[] = [];
  const selected = tool(name), evidence = tool("read_evidence");
  const model = descriptor({ providerId: "fixture", modelId: "diff-page", displayName: "diff-page", maxContextTokens: 256_000 });
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) yield { type: "tool_call", toolCall: { id: "inspect-diff", name, input: {} } };
      else yield { type: "text_delta", delta: "reviewed" };
    },
  };
  const options: PiAgentBridgeOptions = {
    runId: "diff-bridge", sessionId: "diff-bridge", provider, model,
    initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: "Review the complete diff." }] }],
    contracts: [selected.contract, evidence.contract], resolveTool: selectedName => selectedName === name ? selected : selectedName === "read_evidence" ? evidence : undefined,
    externalSignal: new AbortController().signal, maxOutputTokens: 256, parallelToolCalls: false,
    beforeToolCall: async () => ({}), executeTool: async () => ({ output }), shouldStopAfterTurn: () => false,
    onProviderEvent: () => {}, onContextAdjustment: adjustment => { adjustments.push(adjustment); },
  };
  const result = await runWithPiAgent(options);
  expect(result.errorMessage).toBeUndefined();
  expect(requests).toHaveLength(2);
  const received = resultParts(requests[1]!)[0]!;
  expect(received).toMatchObject({ toolCallId: "inspect-diff", trust: "untrusted_tool" });
  return { received: received.output as ToolResult, adjustments };
}

describe("workspace diff pages reach the model intact", () => {
  it("preserves source markers beyond 8KB in actual untrusted tool_result messages", async () => {
    const output = page();
    const serialized = JSON.stringify(output);
    expect(serialized.indexOf(MIDDLE)).toBeGreaterThan(8000);
    expect(serialized.indexOf(TAIL)).toBeGreaterThan(8000);
    expect(Buffer.byteLength(serialized)).toBeLessThan(80_000);
    const { received, adjustments } = await throughBridge(output);
    expect(received.output).toEqual(output);
    expect(JSON.stringify(received.output)).toContain(MIDDLE);
    expect(JSON.stringify(received.output)).toContain(TAIL);
    expect(adjustments.some(item => item.kind === "tool_result_bound")).toBe(false);
  });

  it("includes the exact 80,000-byte boundary and bounds the next byte", async () => {
    const fixedBytes = Buffer.byteLength(JSON.stringify(page("")));
    const exact = page("x".repeat(80_000 - fixedBytes));
    const oversized = page("x".repeat(80_001 - fixedBytes));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(80_000);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(80_001);
    expect((await throughBridge(exact)).received.output).toEqual(exact);
    const bounded = await throughBridge(oversized);
    expect(bounded.received.output).toMatchObject({ truncated: true, evidenceId: "inspect-diff", originalCharacters: 80_001 });
    expect(bounded.adjustments.some(item => item.kind === "tool_result_bound")).toBe(true);
  });

  it.each([
    { label: "missing pagination summary", name: "workspace_diff", output: { ...page(), summary: undefined } },
    { label: "non-numeric coveredParts", name: "workspace_diff", output: { ...page(), summary: { coveredParts: "1", pagesRead: 1 } } },
    { label: "missing pagesRead", name: "workspace_diff", output: { ...page(), summary: { coveredParts: 1 } } },
    { label: "different source", name: "workspace_diff", output: { ...page(), source: "other" } },
    { label: "different tool", name: "read_file", output: page() },
    { label: "git_diff", name: "git_diff", output: page() },
    { label: "80KB exceeded by UTF-8 bytes", name: "workspace_diff", output: page("中".repeat(30_000)) },
  ])("keeps the normal preview limit for $label", async ({ name, output }) => {
    const { received, adjustments } = await throughBridge(output, name);
    expect(received.output).toMatchObject({ truncated: true, evidenceId: "inspect-diff", instruction: expect.stringContaining("read_evidence") });
    expect(JSON.stringify(received.output).length).toBeLessThan(10_000);
    expect(JSON.stringify(received.output)).not.toContain(MIDDLE);
    expect(JSON.stringify(received.output)).not.toContain(TAIL);
    expect(adjustments.filter(item => item.kind === "tool_result_bound")).toHaveLength(1);
  });
});

const context = (root: string) => ({ runId: "diff-session", workspacePath: root, grants: [], signal: new AbortController().signal });
interface RealPage {
  source: string;
  files: Array<{ path: string; diff?: string }>;
  complete: boolean;
  hasMore: boolean;
  nextCursor?: string;
  summary: { coveredParts: number; totalParts: number; pagesRead: number };
}
async function workspace(run: (root: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "harness-diff-bridge-"));
  const root = join(parent, "work"); await mkdir(root);
  try { await run(root); }
  finally {
    const path = relative(tmpdir(), parent);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Unsafe cleanup");
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe("workspace diff session evidence boundaries", () => {
  it("delivers every real page through the bridge before final coverage is complete", () => workspace(async root => {
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    const content = "a".repeat(14_000) + MIDDLE + "b".repeat(90_000) + TAIL + "c".repeat(50_000);
    await writeFile(join(root, "room.tsx"), content);
    const receivedPages: RealPage[] = [];
    const executed: ToolResult[] = [];
    const diffTool = diff.tool(), evidence = tool("read_evidence");
    const model = descriptor({ providerId: "fixture", modelId: "real-diff-page", displayName: "real-diff-page", maxContextTokens: 512_000 });
    let requests = 0;
    const provider: ModelProvider = {
      id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) {
        requests++;
        const last = resultParts(request).at(-1);
        if (!last) { yield { type: "tool_call", toolCall: { id: "page-1", name: "workspace_diff", input: {} } }; return; }
        expect(last.trust).toBe("untrusted_tool");
        const received = last.output as ToolResult;
        expect(received.output).toEqual(executed.at(-1)!.output);
        const current = received.output as RealPage;
        expect(current.source).toBe("workspace_baseline");
        expect(current.summary.pagesRead).toBe(receivedPages.length + 1);
        receivedPages.push(current);
        if (current.hasMore) {
          expect(current.complete).toBe(false);
          expect(received.truncated).toBe(true);
          yield { type: "tool_call", toolCall: { id: `page-${receivedPages.length + 1}`, name: "workspace_diff", input: { cursor: current.nextCursor } } };
        } else { expect(current.complete).toBe(true); yield { type: "text_delta", delta: "Every diff page reviewed." }; }
      },
    };
    const result = await runWithPiAgent({
      runId: "real-diff-bridge", sessionId: "real-diff-bridge", provider, model,
      initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: "Review every source page." }] }],
      contracts: [diffTool.contract, evidence.contract], resolveTool: name => name === "workspace_diff" ? diffTool : evidence,
      externalSignal: new AbortController().signal, maxOutputTokens: 256, parallelToolCalls: false,
      beforeToolCall: async () => ({}), executeTool: async call => { const output = await diffTool.execute(call.input, context(root)); executed.push(output); return output; },
      shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    });
    expect(result.errorMessage).toBeUndefined();
    expect(receivedPages.length).toBeGreaterThan(1);
    expect(requests).toBe(receivedPages.length + 1);
    const text = receivedPages.flatMap(current => current.files).map(file => file.diff ?? "").join("");
    expect(text).toBe("--- /dev/null\n+++ room.tsx\n-\n+" + content);
    expect(text).toContain(MIDDLE); expect(text).toContain(TAIL);
    expect(receivedPages.at(-1)!.summary.coveredParts).toBe(receivedPages.at(-1)!.summary.totalParts);
  }));

  it("does not count replayed cursors and invalidates cursors when a new review starts", () => workspace(async root => {
    const diff = new WorkspaceDiff(root); await diff.prepare(context(root).signal);
    await writeFile(join(root, "room.tsx"), "x".repeat(250_000));
    const first = (await diff.tool().execute({}, context(root))).output as RealPage;
    const second = (await diff.tool().execute({ cursor: first.nextCursor }, context(root))).output as RealPage;
    expect(second.summary.coveredParts).toBeGreaterThan(first.summary.coveredParts);
    expect(second.summary.pagesRead).toBe(2);
    expect(await diff.tool().execute({ cursor: first.nextCursor }, context(root))).toMatchObject({ isError: true, truncated: true, output: { code: "diff_cursor_invalid", complete: false } });
    const third = (await diff.tool().execute({ cursor: second.nextCursor }, context(root))).output as RealPage;
    expect(third.summary.pagesRead).toBe(3);
    const fresh = (await diff.tool().execute({}, context(root))).output as RealPage;
    expect(fresh.summary.pagesRead).toBe(1);
    expect(await diff.tool().execute({ cursor: third.nextCursor }, context(root))).toMatchObject({ isError: true, truncated: true, output: { code: "diff_cursor_invalid", complete: false } });
    expect(await new WorkspaceDiff(root).tool().execute({ cursor: fresh.nextCursor }, context(root))).toMatchObject({ isError: true, truncated: true, output: { code: "diff_cursor_invalid", complete: false } });
  }));
});
