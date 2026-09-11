import type { ModelRequest } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";
export interface RequestTiming { purpose: "main" | "compaction" | "review"; durationMs: number; succeeded: boolean }
/** Client-observed request + streaming duration. Excludes tools, approval and retry backoff. */
export async function* timedProviderStream(provider: ModelProvider, request: ModelRequest, signal: AbortSignal, finished?: (timing: RequestTiming) => void) {
  const started = performance.now();
  let succeeded = false;
  try { yield* provider.stream(request, signal); succeeded = !signal.aborted; }
  finally { finished?.({ purpose: request.purpose ?? "main", durationMs: Math.max(0, performance.now() - started), succeeded }); }
}
