import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { ConversationTaskSchema, type ConversationTask } from "@harness/protocol";
import { ConversationTaskScheduler } from "../packages/core/src/conversation-task-scheduler.js";

/** Synthetic fixed provider responses isolate dispatcher throughput from model/network variability. */
async function measure(maxParallel: number) {
  const at = "2026-10-15T00:00:00.000Z";
  const rows = new Map(Array.from({ length: 8 }, (_, index) => {
    const row = ConversationTaskSchema.parse({ taskId: `task-${index}`, sessionId: "fixture", parentRunId: "parent", stepId: `step-${index}`, planGeneration: 0,
      source: { kind: "run" }, mode: "read", prompt: "Return the same fixed analysis", createdAt: at, updatedAt: at });
    return [row.taskId, row];
  }));
  let active = 0, peakConcurrent = 0, modelRequests = 0, inputTokens = 0, outputTokens = 0, failures = 0;
  const fakeProvider = async (row: ConversationTask) => {
    modelRequests++; inputTokens += 32;
    await new Promise(resolve => setTimeout(resolve, 25));
    const failed = row.taskId === "task-6";
    outputTokens += failed ? 8 : 16;
    if (failed) throw new Error("fixed fixture failure");
  };
  const scheduler = new ConversationTaskScheduler({
    maxParallel, isolatedWrites: false, list: () => [...rows.values()], eligible: row => rows.get(row.taskId)?.executionState === "queued",
    execute: async row => {
      active++; peakConcurrent = Math.max(peakConcurrent, active);
      rows.set(row.taskId, { ...row, executionState: "running" });
      try { await fakeProvider(row); rows.set(row.taskId, { ...row, executionState: "awaiting_integration" }); }
      catch { failures++; rows.set(row.taskId, { ...row, executionState: "failed" }); }
      finally { active--; }
    }, onError: error => { throw error; },
  });
  const before = performance.now(); scheduler.notify(); await scheduler.settle();
  return { concurrency: maxParallel, elapsedMs: Math.round((performance.now() - before) * 100) / 100, peakConcurrent,
    modelRequests, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, failures, failureRate: failures / rows.size };
}

it("records serial/concurrent dispatcher fixture throughput and equal request/usage outcomes", async () => {
  const serial = await measure(1), parallel = await measure(4);
  console.log("CONVERSATION_TASK_PERFORMANCE", JSON.stringify({ fixture: "8 independent read tasks; 25 ms fixed fake-provider latency per task; one fixed failure", serial, parallel }));
  expect(serial.peakConcurrent).toBe(1); expect(parallel.peakConcurrent).toBe(4);
  for (const key of ["modelRequests", "inputTokens", "outputTokens", "totalTokens", "failures", "failureRate"] as const) expect(parallel[key]).toBe(serial[key]);
  expect(serial.modelRequests).toBe(8);
  expect(serial.totalTokens).toBe(376);
  expect(serial.failures).toBe(1);
});
