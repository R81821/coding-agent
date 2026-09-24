import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { waitForRunResult, waitForAll } from "../packages/core/src/run-completion.js";
import type { AgentEvent } from "@harness/protocol";

class EngineFixture extends EventEmitter {
  cancelled: string[] = [];
  cancel(id: string) { this.cancelled.push(id); return true; }
}
const result: Extract<AgentEvent, { type: "result" }> = {
  id: "result", runId: "child", type: "result", status: "cancelled", text: "cancelled", at: new Date().toISOString(), sequence: 0,
};

it("does not start a delegated run after its parent was cancelled", async () => {
  const engine = new EngineFixture();
  const controller = new AbortController();
  controller.abort(new Error("parent cancelled"));
  let started = false;
  await expect(waitForRunResult(engine, "child", controller.signal, () => { started = true; })).rejects.toThrow("parent cancelled");
  expect(started).toBe(false);
  expect(engine.listenerCount("event")).toBe(0);
});

it("waits for cancelled children to finish before releasing their workspaces", async () => {
  const engine = new EngineFixture();
  const controller = new AbortController();
  let finished = false;
  const completion = waitForRunResult(engine, "child", controller.signal, () => {});
  const outcome = completion.then(() => { finished = true; }, () => { finished = true; });
  controller.abort(new Error("parent cancelled"));
  await new Promise<void>(done => setImmediate(done));
  expect(engine.cancelled).toEqual(["child"]);
  expect(finished).toBe(false);
  engine.emit("event", result);
  await expect(completion).rejects.toThrow("parent cancelled");
  await outcome;
  expect(engine.listenerCount("event")).toBe(0);
});

it("cleans up listeners when starting a run throws", async () => {
  const engine = new EngineFixture();
  const controller = new AbortController();
  await expect(waitForRunResult(engine, "child", controller.signal, () => { throw new Error("start failed"); })).rejects.toThrow("start failed");
  expect(engine.listenerCount("event")).toBe(0);
  controller.abort();
  expect(engine.cancelled).toEqual([]);
});

it("handles synchronous completion and ignores other runs", async () => {
  const engine = new EngineFixture();
  const controller = new AbortController();
  const completion = waitForRunResult(engine, "child", controller.signal, () => {
    engine.emit("event", { ...result, runId: "other" });
    engine.emit("event", { ...result, status: "completed" });
  });
  await expect(completion).resolves.toMatchObject({ runId: "child", status: "completed" });
  expect(engine.listenerCount("event")).toBe(0);
});

it("waits for sibling cleanup even when another delegated operation fails", async () => {
  let release!: () => void;
  const sibling = new Promise<string>(done => { release = () => done("cleaned up"); });
  let settled = false;
  const completion = waitForAll([Promise.reject(new Error("child failed")), sibling]);
  const observed = completion.catch(() => { settled = true; });
  await new Promise<void>(done => setImmediate(done));
  const beforeCleanup = settled;
  release();
  await expect(completion).rejects.toThrow("child failed");
  await observed;
  expect(beforeCleanup).toBe(false);
});

it("retains the child workspace after its result until run cleanup has settled", async () => {
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const engine = Object.assign(new EngineFixture(), { waitForSettlement: (_id: string) => cleanup });
  let workspaceReleased = false;
  const completion = waitForRunResult(engine, "child", new AbortController().signal, () => {});
  const observed = completion.then(() => { workspaceReleased = true; });
  engine.emit("event", { ...result, status: "completed" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const releasedBeforeCleanup = workspaceReleased;
  release();
  await observed;
  expect(releasedBeforeCleanup).toBe(false);
  expect(workspaceReleased).toBe(true);
});
