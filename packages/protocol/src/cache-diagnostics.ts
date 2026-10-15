import { z } from "zod";
import type { AgentEvent } from "./index.js";

export const SummaryOutcomeSchema = z.enum(["accepted", "truncated", "empty", "invalid_json", "provider_error", "deterministic", "unsupported", "disabled_after_failure", "budget_exhausted", "target_fallback"]);
export type SummaryOutcome = z.infer<typeof SummaryOutcomeSchema>;
export const ContextAdjustmentSchema = z.object({
  kind: z.enum(["tool_result_bound", "tool_prune", "full_compaction", "runtime_control_removed", "resume_rebuild", "policy_migration"]),
  beforeTokens: z.number().nonnegative().optional(), afterTokens: z.number().nonnegative().optional(),
  capacityTokens: z.number().positive().optional(), triggerTokens: z.number().nonnegative().optional(), targetTokens: z.number().nonnegative().optional(),
  beforeCharacters: z.number().nonnegative().optional(), afterCharacters: z.number().nonnegative().optional(),
  summaryOutcome: SummaryOutcomeSchema.optional(), policyVersion: z.number().int().optional(),
});
export type ContextAdjustment = z.infer<typeof ContextAdjustmentSchema>;
export const ContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  capacityTokens: z.number().int().positive(),
  source: z.enum(["estimate", "provider"]),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

/** Only an applied history change can justify an estimated drop in context. */
export function isCommittedContextAdjustment(adjustment: ContextAdjustment): boolean {
  return adjustment.afterTokens !== undefined && Number.isFinite(adjustment.afterTokens) && adjustment.afterTokens >= 0
    && ["tool_result_bound", "tool_prune", "full_compaction", "runtime_control_removed"].includes(adjustment.kind);
}

/** Recover the latest request footprint, including runs saved before context_usage. */
export function latestContextUsage(events: readonly AgentEvent[], options: { preserveMeasurements?: boolean } = {}): ContextUsage | undefined {
  let capacityTokens: number | undefined;
  let measurement: Pick<ContextUsage, "usedTokens" | "source"> | undefined;
  let route: Extract<AgentEvent, { type: "route" }> | undefined;
  let compactedEstimatePending = false;
  const validTokens = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  const updateEstimate = (usedTokens: number, nextCapacity: number | undefined, committed = false) => {
    // Run/resume initialization starts with fresh calibration. That provisional estimate
    // must not erase the retained footprint; real usage and committed changes can lower it.
    if (!options.preserveMeasurements || !measurement || capacityTokens !== nextCapacity
      || usedTokens >= measurement.usedTokens || committed) measurement = { usedTokens, source: "estimate" };
    capacityTokens = nextCapacity;
  };
  for (const event of events) {
    if (event.type === "route") {
      if (route && (route.providerId !== event.providerId || route.modelId !== event.modelId)) {
        capacityTokens = undefined;
        measurement = undefined;
        compactedEstimatePending = false;
      }
      route = event;
    } else if (event.type === "context_usage") {
      const context = event.context;
      const nextCapacity = validTokens(context.capacityTokens) && context.capacityTokens > 0 ? context.capacityTokens : undefined;
      if (!validTokens(context.usedTokens)) {
        capacityTokens = nextCapacity;
        measurement = undefined;
      } else if (context.source === "estimate") {
        updateEstimate(context.usedTokens, nextCapacity, compactedEstimatePending);
      } else {
        capacityTokens = nextCapacity;
        measurement = { usedTokens: context.usedTokens, source: context.source };
      }
      compactedEstimatePending = false;
    } else if (event.type === "context_compacted") {
      // The checkpoint is already saved. Accept its following estimate once, rather
      // than letting an old compaction authorize every later resume estimate.
      compactedEstimatePending = true;
    } else if (event.type === "context_adjusted") {
      const adjustment = event.adjustment;
      if (adjustment.kind === "resume_rebuild" || adjustment.kind === "policy_migration") compactedEstimatePending = false;
      const nextCapacity = validTokens(adjustment.capacityTokens) && adjustment.capacityTokens > 0 ? adjustment.capacityTokens : capacityTokens;
      if (validTokens(adjustment.afterTokens)) {
        updateEstimate(adjustment.afterTokens, nextCapacity, isCommittedContextAdjustment(adjustment));
        compactedEstimatePending = false;
      } else {
        if (options.preserveMeasurements && nextCapacity !== capacityTokens) measurement = undefined;
        capacityTokens = nextCapacity;
      }
    } else if (event.type === "usage" && (event.usage.purpose === undefined || event.usage.purpose === "main")) {
      const usage = event.usage;
      // Adapters normalize absent input usage to zero; that is not an empty context.
      if (validTokens(usage.inputTokens) && usage.inputTokens > 0 && validTokens(usage.outputTokens)) {
        measurement = { usedTokens: usage.inputTokens + usage.outputTokens, source: "provider" };
        compactedEstimatePending = false;
      }
    }
  }
  return capacityTokens !== undefined && measurement ? { ...measurement, capacityTokens } : undefined;
}
export const CacheDiagnosticSchema = z.object({
  purpose: z.enum(["main", "compaction", "review", "sampling"]),
  protocol: z.enum(["responses", "chat_completions", "anthropic", "gemini"]),
  reason: z.enum(["first_request", "append", "rewrite", "continuation", "continuation_fallback"]),
  unchangedPrefixItems: z.number().int().nonnegative(), inputItems: z.number().int().nonnegative(),
  sharedPrefixCharacters: z.number().int().nonnegative(), payloadCharacters: z.number().int().nonnegative(),
});
export type CacheDiagnostic = z.infer<typeof CacheDiagnosticSchema>;
