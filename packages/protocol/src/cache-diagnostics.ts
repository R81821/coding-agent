import { z } from "zod";

export const SummaryOutcomeSchema = z.enum(["accepted", "truncated", "empty", "invalid_json", "provider_error", "deterministic", "unsupported", "disabled_after_failure", "budget_exhausted", "target_fallback"]);
export type SummaryOutcome = z.infer<typeof SummaryOutcomeSchema>;
export const ContextAdjustmentSchema = z.object({
  kind: z.enum(["tool_result_bound", "tool_prune", "full_compaction", "resume_rebuild", "policy_migration"]),
  beforeTokens: z.number().nonnegative().optional(), afterTokens: z.number().nonnegative().optional(),
  capacityTokens: z.number().positive().optional(), triggerTokens: z.number().nonnegative().optional(), targetTokens: z.number().nonnegative().optional(),
  beforeCharacters: z.number().nonnegative().optional(), afterCharacters: z.number().nonnegative().optional(),
  summaryOutcome: SummaryOutcomeSchema.optional(), policyVersion: z.number().int().optional(),
});
export type ContextAdjustment = z.infer<typeof ContextAdjustmentSchema>;
export const CacheDiagnosticSchema = z.object({
  purpose: z.enum(["main", "compaction", "review"]),
  protocol: z.enum(["responses", "chat_completions", "anthropic", "gemini"]),
  reason: z.enum(["first_request", "append", "rewrite", "continuation", "continuation_fallback"]),
  unchangedPrefixItems: z.number().int().nonnegative(), inputItems: z.number().int().nonnegative(),
  sharedPrefixCharacters: z.number().int().nonnegative(), payloadCharacters: z.number().int().nonnegative(),
});
export type CacheDiagnostic = z.infer<typeof CacheDiagnosticSchema>;
