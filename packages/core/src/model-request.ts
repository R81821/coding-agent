import type { ModelRequest } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";
export interface RequestTiming {
  purpose: "main" | "compaction" | "review";
  durationMs: number;
  succeeded: boolean;
  maxOutputTokens?: number;
  configuredMaxOutputTokens?: number;
  attempt?: number;
  errorCode?: string;
}
/** Client-observed request + streaming duration. Excludes tools, approval and retry backoff. */
export async function* timedProviderStream(provider: ModelProvider, request: ModelRequest, signal: AbortSignal, finished?: (timing: RequestTiming) => void, diagnostics?: Pick<RequestTiming, "configuredMaxOutputTokens" | "attempt">) {
  const started = performance.now();
  let succeeded = false;
  let errorCode: string | undefined;
  try { yield* provider.stream(request, signal); succeeded = !signal.aborted; }
  catch (error) {
    errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "provider_error";
    throw error;
  }
  finally { finished?.({ purpose: request.purpose ?? "main", durationMs: Math.max(0, performance.now() - started), succeeded, maxOutputTokens: request.maxOutputTokens, ...diagnostics, ...(errorCode ? { errorCode } : signal.aborted ? { errorCode: "aborted" } : {}) }); }
}
