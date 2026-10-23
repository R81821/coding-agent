import { createHash } from "node:crypto";
import type { ModelRequest, RequestDiagnostic } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";
export interface RequestTiming {
  purpose: "main" | "compaction" | "review" | "sampling" | "memory";
  durationMs: number;
  succeeded: boolean;
  maxOutputTokens?: number;
  configuredMaxOutputTokens?: number;
  attempt?: number;
  errorCode?: string;
  requestDiagnostic?: RequestDiagnostic;
}
/** Structural diagnostics only: no request text, credentials, paths or attachment bytes. */
export function diagnoseRequest(request: ModelRequest): RequestDiagnostic {
  const textChars = { instructions: 0, profile: 0, project: 0, memory: 0, conversation: 0, toolResults: 0 };
  const attachments: unknown[] = [];
  for (const message of request.messages) for (const part of message.content) {
    if (part.type === "image" || part.type === "file") { attachments.push({ sha256: part.attachment.sha256, mimeType: part.attachment.mimeType, byteLength: part.attachment.byteLength, width: part.attachment.width, height: part.attachment.height, ...(part.type === "image" ? { detail: part.detail } : {}) }); continue; }
    if (part.type !== "text") continue;
    const category = message.role === "system" ? "instructions" : message.role === "developer" ? "profile" :
      message.role === "tool" ? "toolResults" : part.trust === "trusted_project" ? "project" : part.trust === "user_profile" ? "memory" : "conversation";
    textChars[category] += part.text.length;
  }
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const schemas = JSON.stringify(request.tools);
  return { boundary: "provider_request", providerId: request.model.providerId, modelId: request.model.modelId,
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}), maxOutputTokens: request.maxOutputTokens,
    messageCount: request.messages.length, toolCount: request.tools.length, toolSchemaChars: schemas.length, toolSchemaHash: hash(schemas),
    textChars, attachmentCount: attachments.length, attachmentManifestHash: hash(JSON.stringify(attachments)) };
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
  finally { finished?.({ purpose: request.purpose ?? "main", durationMs: Math.max(0, performance.now() - started), succeeded, requestDiagnostic: diagnoseRequest(request), maxOutputTokens: request.maxOutputTokens, ...diagnostics, ...(errorCode ? { errorCode } : signal.aborted ? { errorCode: "aborted" } : {}) }); }
}
