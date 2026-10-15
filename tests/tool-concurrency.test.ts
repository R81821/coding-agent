import { describe, expect, it } from "vitest";
import { BoundedExecutionPool, boundModelProvider, concurrencyLimit, isParallelRead, runWithPiAgent, SerialCommitQueue, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { AttachmentRef, ModelMessage, ModelRequest, ToolCall } from "@harness/protocol";
import { pagedReadTool, createWebSearchTool, type ToolDefinition, type ToolResult } from "@harness/tools";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(done => setImmediate(done));
const signal = () => new AbortController().signal;

function fixture(input: {
  tool?: ToolDefinition;
  calls?: ToolCall[];
  parallelTools?: boolean;
  limit?: number;
  execute(call: ToolCall): Promise<ToolResult>;
}) {
  const tool: ToolDefinition = input.tool ?? { ...pagedReadTool, contract: { ...pagedReadTool.contract, inputSchema: { type: "object" } } };
  const model = descriptor({ providerId: "fixture", modelId: "model", displayName: "fixture", capabilities: { vision: true, tools: true, parallelTools: input.parallelTools ?? true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fixture", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) for (const call of input.calls ?? ["a", "b", "c"].map(id => ({ id, name: tool.contract.name, input: { path: `${id}.ts` } }))) yield { type: "tool_call", toolCall: call };
      else yield { type: "text_delta", delta: "done" };
    },
  };
  const checkpoints: ModelMessage[][] = [];
  const options: PiAgentBridgeOptions = {
    runId: "run", sessionId: "session", model, provider,
    initialMessages: [{ role: "user", content: [{ type: "text", trust: "user_request", text: "Read independent source files" }] }],
    contracts: [tool.contract], resolveTool: name => name === tool.contract.name ? tool : undefined,
    externalSignal: signal(), maxOutputTokens: 100, parallelToolCalls: true, maxConcurrentTools: input.limit ?? 2,
    beforeToolCall: async () => ({}), executeTool: input.execute,
    shouldStopAfterTurn: () => false, onProviderEvent: () => {},
    onTranscript: messages => { checkpoints.push(structuredClone(messages)); },
  };
  return { options, requests, checkpoints };
}

describe("bounded tool execution", () => {
  it("overlaps independent reads and immediately fills a released slot", async () => {
    const pool = new BoundedExecutionPool(2);
    const a = gate(), b = gate(), c = gate();
    const started: string[] = [];
    const execute = (id: string, wait: Promise<void>) => pool.run(signal(), true, async () => { started.push(id); await wait; return id; });
    const results = [execute("a", a.promise), execute("b", b.promise), execute("c", c.promise)];
    await tick();
    expect(started).toEqual(["a", "b"]);
    b.resolve(); await tick();
    expect(started).toEqual(["a", "b", "c"]);
    c.resolve(); a.resolve();
    expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
  });

  it("serializes a conflicting writer and does not let later reads bypass it", async () => {
    const pool = new BoundedExecutionPool(3);
    const a = gate(), write = gate();
    const started: string[] = [];
    const first = pool.run(signal(), true, async () => { started.push("read-a"); await a.promise; });
    const writer = pool.run(signal(), false, async () => { started.push("write"); await write.promise; });
    const last = pool.run(signal(), true, async () => { started.push("read-b"); });
    await tick(); expect(started).toEqual(["read-a"]);
    a.resolve(); await first; await tick(); expect(started).toEqual(["read-a", "write"]);
    write.resolve(); await Promise.all([writer, last]); expect(started).toEqual(["read-a", "write", "read-b"]);
  });

  it("removes aborted queued items without starting them or leaking their slots", async () => {
    const pool = new BoundedExecutionPool(1);
    const release = await pool.acquire(signal());
    const aborted = new AbortController();
    const pending = pool.acquire(aborted.signal);
    const error = new Error("paused queued request");
    const rejected = expect(pending).rejects.toBe(error);
    aborted.abort(error); await rejected;
    release(); release();
    await expect(pool.run(signal(), true, () => 42)).resolves.toBe(42);
  });

  it("requires trusted implementation metadata, actual read risk and idempotence", () => {
    expect(isParallelRead(pagedReadTool, {})).toBe(true);
    const unreviewed = { ...pagedReadTool }; delete unreviewed.parallelReadScope;
    expect(isParallelRead(unreviewed, {})).toBe(false);
    expect(isParallelRead({ ...pagedReadTool, assessRisk: () => "high" }, {})).toBe(false);
    expect(isParallelRead({ ...pagedReadTool, contract: { ...pagedReadTool.contract, idempotent: false } }, {})).toBe(false);
    expect(isParallelRead({ ...pagedReadTool, external: { serverId: "mcp", serverName: "MCP", toolName: "read", revision: 1, contractHash: "hash" } }, {})).toBe(false);
    expect(isParallelRead(createWebSearchTool({ id: "search", health: async () => ({ healthy: true }), search: async () => { throw new Error("unused"); } }), { includeRepositoryContext: true })).toBe(false);
    for (const value of [0, -1, 1.5, NaN, Infinity, 1025]) expect(() => concurrencyLimit(value, 4, "tools")).toThrow();
  });

  it("serializes state commits after failures without blocking later valid commits", async () => {
    const queue = new SerialCommitQueue();
    const first = gate();
    const values: number[] = [];
    const a = queue.run(async () => { values.push(1); await first.promise; throw new Error("commit failed"); });
    const failed = expect(a).rejects.toThrow("commit failed");
    const b = queue.run(() => { values.push(2); });
    await tick(); expect(values).toEqual([1]);
    first.resolve(); await failed; await b; await queue.idle(); expect(values).toEqual([1, 2]);
  });
});

describe("pi bridge controlled concurrency", () => {
  it("records the same fake workload with serial and bounded read execution", async () => {
    const measurements: Array<{ limit: number; durationMs: number; peak: number; modelRequests: number; inputTokens: number; outputTokens: number; failures: number }> = [];
    for (const limit of [1, 2]) {
      let active = 0, peak = 0, inputTokens = 0, outputTokens = 0;
      const run = fixture({ limit, execute: async call => {
        active++; peak = Math.max(peak, active);
        try { await new Promise<void>(done => setTimeout(done, 40)); return { output: call.id }; }
        finally { active--; }
      } });
      const original = run.options.provider;
      run.options.provider = { ...original, async *stream(request, signal) {
        yield* original.stream(request, signal);
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: 0, costKnown: true } };
      } };
      run.options.onProviderEvent = event => { if (event.type === "usage" && event.usage) { inputTokens += event.usage.inputTokens; outputTokens += event.usage.outputTokens; } };
      const start = performance.now();
      const result = await runWithPiAgent(run.options);
      measurements.push({ limit, durationMs: Math.round((performance.now() - start) * 100) / 100, peak, modelRequests: run.requests.length, inputTokens, outputTokens, failures: result.errorMessage ? 1 : 0 });
    }
    expect(measurements.map(({ durationMs: _duration, ...measurement }) => measurement)).toEqual([
      { limit: 1, peak: 1, modelRequests: 2, inputTokens: 200, outputTokens: 20, failures: 0 },
      { limit: 2, peak: 2, modelRequests: 2, inputTokens: 200, outputTokens: 20, failures: 0 },
    ]);
    process.stdout.write(`Tool concurrency fake-provider benchmark: ${JSON.stringify(measurements)}\n`);
  });

  it("keeps out-of-order results paired in original order and saves a complete image batch", async () => {
    const a = gate(), b = gate(), c = gate();
    const started: string[] = [];
    const image: AttachmentRef = { id: "image", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 1, encryptedPath: "encrypted/image.blob", source: "file", trust: "untrusted_attachment", allowedProviders: ["fixture"], createdAt: "2026-10-15T00:00:00.000Z" };
    const run = fixture({ execute: async call => {
      started.push(call.id);
      await ({ a, b, c }[call.id]!.promise);
      return { output: call.id, ...(call.id === "a" ? { images: [{ attachment: image }] } : {}) };
    } });
    const result = runWithPiAgent(run.options);
    await tick(); expect(started).toEqual(["a", "b"]);
    b.resolve(); await tick(); expect(started).toEqual(["a", "b", "c"]);
    c.resolve(); a.resolve();
    expect((await result).errorMessage).toBeUndefined();
    const messages = run.requests[1]!.messages;
    const calls = messages.findIndex(message => message.role === "assistant");
    expect(messages.slice(calls, calls + 5).map(message => message.role)).toEqual(["assistant", "tool", "tool", "tool", "user"]);
    expect(messages.flatMap(message => message.content.flatMap(part => part.type === "tool_result" ? [part.toolCallId] : []))).toEqual(["a", "b", "c"]);
    expect(run.checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of run.checkpoints) {
      const ids = checkpoint.flatMap(message => message.content.flatMap(part => part.type === "tool_result" ? [part.toolCallId] : []));
      expect(ids).toEqual(["a", "b", "c"]);
    }
  });

  it.each(["model", "tool", "workflow", "limit"])("falls back safely when the %s does not permit parallel reads", async reason => {
    const first = gate(); const started: string[] = [];
    const unknownTool: ToolDefinition = { contract: { ...pagedReadTool.contract, inputSchema: { type: "object" } }, execute: pagedReadTool.execute };
    const run = fixture({ parallelTools: reason !== "model", limit: reason === "limit" ? 1 : 2,
      ...(reason === "tool" ? { tool: unknownTool } : {}),
      execute: async call => { started.push(call.id); if (call.id === "a") await first.promise; return { output: call.id }; } });
    if (reason === "workflow") run.options.canRunToolConcurrently = () => false;
    const result = runWithPiAgent(run.options);
    await tick(); expect(started).toEqual(["a"]);
    first.resolve(); await result;
    expect(started).toEqual(["a", "b", "c"]);
    if (reason === "model" || reason === "limit") expect(run.requests[0]!.parallelToolCalls).toBe(false);
  });

  it("stops queued calls at the pause boundary and preserves one result per call", async () => {
    const first = gate(); const started: string[] = []; let paused = false;
    const run = fixture({ limit: 1, execute: async call => { started.push(call.id); if (call.id === "a") await first.promise; return { output: call.id }; } });
    run.options.canDispatchTool = () => !paused;
    const result = runWithPiAgent(run.options);
    await tick(); paused = true; first.resolve(); await result;
    expect(started).toEqual(["a"]);
    expect(run.requests[1]!.messages.flatMap(message => message.content.flatMap(part => part.type === "tool_result" ? [part.toolCallId] : []))).toEqual(["a", "b", "c"]);
  });

  it("records failed parallel calls once without losing an independent successful result", async () => {
    const run = fixture({ execute: async call => { if (call.id === "b") throw new Error("read failed"); return { output: call.id }; } });
    await runWithPiAgent(run.options);
    const outputs = run.requests[1]!.messages.flatMap(message => message.content.flatMap(part => part.type === "tool_result" ? [part] : []));
    expect(outputs.map(part => part.toolCallId)).toEqual(["a", "b", "c"]);
    expect(outputs[1]!.output).toMatchObject({ isError: true });
  });
});

describe("model request concurrency", () => {
  it("shares the global gate across providers and releases capacity after errors", async () => {
    const wait = gate(); const started: string[] = [];
    const model = descriptor({ providerId: "fixture", modelId: "model", displayName: "fixture" });
    const makeProvider = (id: string): ModelProvider => ({ id, listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream(request) { started.push(request.runId); if (request.runId === "a") { await wait.promise; throw new Error("request failed"); } yield { type: "text_delta", delta: "done" }; } });
    const pool = new BoundedExecutionPool(1);
    const providers = [boundModelProvider(makeProvider("p1"), pool), boundModelProvider(makeProvider("p2"), pool)];
    const base: ModelRequest = { model, messages: [], tools: [], maxOutputTokens: 12345, parallelToolCalls: false, runId: "a", store: false };
    const consume = async (provider: ModelProvider, request: ModelRequest) => { for await (const _event of provider.stream(request, signal())) { /* fully consume the stream */ } };
    const first = consume(providers[0]!, base);
    const failed = expect(first).rejects.toThrow("request failed");
    const second = consume(providers[1]!, { ...base, runId: "b", purpose: "compaction" });
    await tick(); expect(started).toEqual(["a"]);
    wait.resolve(); await failed; await second; expect(started).toEqual(["a", "b"]);
    expect(base.maxOutputTokens).toBe(12345);
    expect(base.model.capabilities.maxContextTokens).toBe(128000);
  });

  it("rechecks queued request eligibility at real dispatch and frees the reservation if rejected", async () => {
    const wait = gate();
    const pool = new BoundedExecutionPool(1);
    const release = await pool.acquire(signal());
    let eligible = true;
    let started = false;
    const model = descriptor({ providerId: "fixture", modelId: "model", displayName: "fixture" });
    const provider = boundModelProvider({ id: "fixture", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream() { started = true; await wait.promise; yield { type: "text_delta", delta: "done" }; } }, pool, () => { if (!eligible) throw new Error("duration budget expired while waiting"); });
    const request: ModelRequest = { model, messages: [], tools: [], maxOutputTokens: 10, parallelToolCalls: false, runId: "run", store: false };
    const consume = async () => { for await (const _event of provider.stream(request, signal())) { /* consume */ } };
    const pending = consume();
    const rejected = expect(pending).rejects.toThrow("duration budget expired");
    eligible = false; release(); await rejected;
    expect(started).toBe(false);
    await expect(pool.run(signal(), true, () => 42)).resolves.toBe(42);
  });
});
