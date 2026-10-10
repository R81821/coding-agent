import type { AgentEvent } from "@harness/protocol";
import type { EventEmitter } from "node:events";

type RunEventSource = Pick<EventEmitter, "on" | "off"> & { cancel(runId: string): boolean; isActive?(runId: string): boolean; waitForSettlement?(runId: string): Promise<void> };

/** Keep the child workspace until the result and all run cleanup have completed. */
export function waitForRunResult(engine: RunEventSource, runId: string, signal: AbortSignal, start: () => void): Promise<Extract<AgentEvent, { type: "result" }>> {
  return new Promise((resolveResult, rejectResult) => {
    if (signal.aborted) { rejectResult(signal.reason); return; }
    const onEvent = (event: AgentEvent) => {
      if (event.runId !== runId || event.type !== "result") return;
      cleanup();
      Promise.resolve(engine.waitForSettlement?.(runId)).then(() => {
        if (signal.aborted) rejectResult(signal.reason);
        else resolveResult(event);
      }, rejectResult);
    };
    const onAbort = () => { engine.cancel(runId); };
    const cleanup = () => { engine.off("event", onEvent); signal.removeEventListener("abort", onAbort); };
    engine.on("event", onEvent);
    signal.addEventListener("abort", onAbort, { once: true });
    try { start(); }
    catch (error) {
      cleanup();
      // Starting may have created a child before its parent record failed validation. Settle it
      // before returning control, so the caller can safely release its workspace.
      if (engine.isActive?.(runId)) engine.cancel(runId);
      Promise.resolve(engine.waitForSettlement?.(runId)).then(() => rejectResult(error), rejectResult);
    }
  });
}

/** Do not return control while sibling operations still own worktrees or are recording results. */
export async function waitForAll<T>(operations: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(operations);
  return settled.map(result => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
