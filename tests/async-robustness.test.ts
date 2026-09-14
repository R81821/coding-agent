import { describe, expect, it } from "vitest";
import { parseSse } from "../packages/providers/src/http.js";
import { ConcurrencyPool } from "@harness/extensions";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function nextTurn() { await new Promise<void>(done => setImmediate(done)); }

const encoder = new TextEncoder();
describe("SSE stream ownership", () => {
  it("rejects cancellation during a pending read and releases the reader", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const iterator = parseSse(response, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const reason = new Error("cancelled while reading");
    const rejection = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("cancels an open body when its consumer stops early", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: {"text":"first"}\n\n')); },
      cancel() { cancelled = true; },
    }));
    for await (const event of parseSse(response, new AbortController().signal)) {
      expect(event).toEqual({ text: "first" });
      break;
    }
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("stops at DONE and ignores subsequent frames", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\ndata: {"unexpected":true}\n\n')); },
      cancel() { cancelled = true; },
    }));
    const iterator = parseSse(response, new AbortController().signal)[Symbol.asyncIterator]();
    try { expect(await iterator.next()).toEqual({ done: true, value: undefined }); }
    finally { await iterator.return?.(); }
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("preserves the original cancellation error if stream cleanup rejects", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel() { return Promise.reject(new Error("cleanup failed")); } }));
    const iterator = parseSse(response, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const reason = new Error("cancelled");
    const rejection = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    await nextTurn();
    expect(response.body?.locked).toBe(false);
  });
});

describe("concurrency pool handoff", () => {
  it("reserves the released slot for the queued waiter before admitting newcomers", async () => {
    const pool = new ConcurrencyPool(1);
    const firstGate = deferred();
    const queuedGate = deferred();
    let active = 0, maximum = 0;
    const order: string[] = [];
    const operation = async (name: string, gate?: Promise<void>) => {
      order.push(name);
      maximum = Math.max(maximum, ++active);
      if (gate) await gate;
      active--;
    };
    const first = pool.run(() => operation("first", firstGate.promise));
    const queued = pool.run(() => operation("queued", queuedGate.promise));
    await nextTurn();
    firstGate.resolve();
    // Queue a newcomer between release() and the queued run's continuation.
    await Promise.resolve();
    await Promise.resolve();
    const newcomer = pool.run(() => operation("newcomer"));
    await nextTurn();
    const beforeRelease = [...order];
    queuedGate.resolve();
    await Promise.all([first, queued, newcomer]);
    expect(beforeRelease).toEqual(["first", "queued"]);
    expect(maximum).toBe(1);
    expect(order).toEqual(["first", "queued", "newcomer"]);
  });

  it("removes cancelled waiters promptly without running their operation", async () => {
    const pool = new ConcurrencyPool(1);
    const gate = deferred();
    const first = pool.run(() => gate.promise);
    const controller = new AbortController();
    let ran = false;
    const queued = pool.run(async () => { ran = true; }, controller.signal);
    const outcome = queued.then(() => "resolved", () => "cancelled");
    controller.abort(new Error("queue cancelled"));
    await nextTurn();
    const settled = await Promise.race([outcome, Promise.resolve("pending")]);
    gate.resolve();
    await first;
    await outcome;
    expect(settled).toBe("cancelled");
    expect(ran).toBe(false);
    await expect(pool.run(async () => "available")).resolves.toBe("available");
  });

  it("does not start work with an already aborted signal", async () => {
    const pool = new ConcurrencyPool(1);
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let ran = false;
    await expect(pool.run(async () => { ran = true; }, controller.signal)).rejects.toThrow("already cancelled");
    expect(ran).toBe(false);
  });

  it("returns a reserved slot if cancellation arrives during handoff", async () => {
    const pool = new ConcurrencyPool(1);
    const controller = new AbortController();
    const gate = deferred();
    const first = pool.run(() => gate.promise);
    let ran = false;
    const queued = pool.run(async () => { ran = true; }, controller.signal);
    const cancelled = expect(queued).rejects.toThrow("handoff cancelled");
    await nextTurn();
    gate.resolve();
    await Promise.resolve();
    controller.abort(new Error("handoff cancelled"));
    await first;
    await cancelled;
    expect(ran).toBe(false);
    await expect(pool.run(async () => "slot returned")).resolves.toBe("slot returned");
  });

  it.each([NaN, Infinity, 1.5])("rejects invalid concurrency %s instead of hanging or exceeding capacity", limit => {
    expect(() => new ConcurrencyPool(limit)).toThrow();
  });
});
