import type { AgentEvent } from "@harness/protocol";
import type { EventEmitter } from "node:events";

type RunEventSource = Pick<EventEmitter, "on" | "off"> & { cancel(runId: string): boolean };

/** Keep ownership of the child workspace until the child reports a terminal result. */
export function waitForRunResult(engine: RunEventSource, runId: string, signal: AbortSignal, start: () => void): Promise<Extract<AgentEvent, { type: "result" }>> {
  return new Promise((resolveResult, rejectResult) => {
    if (signal.aborted) { rejectResult(signal.reason); return; }
    const onEvent = (event: AgentEvent) => {
      if (event.runId !== runId || event.type !== "result") return;
      cleanup();
      if (signal.aborted) rejectResult(signal.reason);
      else resolveResult(event);
    };
    const onAbort = () => { engine.cancel(runId); };
    const cleanup = () => { engine.off("event", onEvent); signal.removeEventListener("abort", onAbort); };
    engine.on("event", onEvent);
    signal.addEventListener("abort", onAbort, { once: true });
    try { start(); }
    catch (error) { cleanup(); rejectResult(error); }
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
