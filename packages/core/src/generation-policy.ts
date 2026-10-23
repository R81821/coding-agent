import type { GenerationPolicy, ModelDescriptor, ModelMessage, ModelRequest } from "@harness/protocol";

export const DEFAULT_MAX_OUTPUT_TOKENS = 393_216;
export const DEFAULT_REVIEW_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS = 32_768;

export function resolveMainOutputTokens(policy?: GenerationPolicy): number {
  return policy?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export function resolveReviewOutputLimit(policy?: GenerationPolicy): number {
  return policy?.reviewMaxOutputTokens ?? DEFAULT_REVIEW_MAX_OUTPUT_TOKENS;
}

export function resolveCompactionOutputLimit(policy?: GenerationPolicy): number {
  return policy?.compactionMaxOutputTokens ?? DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS;
}

export function initialReviewOutputTokens(requirementCount: number, hardLimit = DEFAULT_REVIEW_MAX_OUTPUT_TOKENS): number {
  return Math.min(hardLimit, 16_384, Math.max(8192, requirementCount * 400));
}

/** A retry must increase the actual allowance, rather than repeat a truncated request. */
export function nextReviewOutputTokens(previousActual: number, hardLimit = DEFAULT_REVIEW_MAX_OUTPUT_TOKENS): number | undefined {
  const next = Math.min(hardLimit, previousActual * 2);
  return next > previousActual ? next : undefined;
}

/** Cautious estimate for fresh, uncalibrated requests, including system text and schemas. */
export function estimateRequestInputTokens(request: Pick<ModelRequest, "messages" | "tools">): number {
  const payload = JSON.stringify({ messages: request.messages, tools: request.tools });
  const asciiLength = payload.replace(/[^\x00-\x7f]/g, "").length;
  return Math.max(1, Math.ceil(asciiLength / 2 + Buffer.byteLength(payload, "utf8") - asciiLength + fileInputTokenReserve(request.messages)));
}

/** File refs expand to extracted document text at provider dispatch. */
export function fileInputTokenReserve(messages: ModelMessage[]): number {
  return messages.flatMap(message => message.content).reduce((total, part) => part.type !== "file" ? total
    : total + (part.attachment.textTokenEstimate ?? Math.ceil(part.attachment.byteLength / 2)), 0);
}

/** Never removes input evidence to create room for generated text. */
export function resolveRequestOutputTokens(input: {
  model: ModelDescriptor;
  maxOutputTokens: number;
  estimatedInputTokens: number;
}): number {
  const context = input.model.capabilities.maxContextTokens;
  const overhead = Math.min(1024, Math.floor(context / 16));
  const available = Math.floor(context - input.estimatedInputTokens - overhead);
  if (available < 1) throw Object.assign(new Error("context_budget_exceeded: input and tool schemas exceed the model context budget"), { code: "context_budget_exceeded" });
  // Context capacity bounds input + output; it is never evidence of output
  // support. A missing capability still needs a finite ceiling, including when
  // an internal caller asks for all available output with Infinity.
  const outputLimit = input.model.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const resolved = Math.floor(Math.min(input.maxOutputTokens, outputLimit, available));
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw Object.assign(new Error("output_budget_invalid: output allowance must be a positive finite integer"), { code: "output_budget_invalid" });
  return resolved;
}
