import type { ToolContract, Usage } from "./index.js";

/** Sort object keys only; array order can carry tool and code semantics. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }) ?? "null";
}
export function stableTools(tools: ToolContract[]): ToolContract[] {
  return JSON.parse(canonicalJson([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) as ToolContract[];
}
export function cacheUsage(inputTokens: number, reported: unknown): Partial<Usage> {
  if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0 || reported > inputTokens) return {};
  return { cachedInputTokens: Math.floor(reported) };
}
export function summarizeCacheUsage(usages: Usage[]) {
  const measured = usages.filter(u => u.cachedInputTokens !== undefined);
  const inputTokens = usages.reduce((sum, u) => sum + u.inputTokens, 0);
  const measuredInputTokens = measured.reduce((sum, u) => sum + u.inputTokens, 0);
  const cachedInputTokens = measured.reduce((sum, u) => sum + Math.min(u.inputTokens, u.cachedInputTokens!), 0);
  return { inputTokens, measuredInputTokens, cachedInputTokens, measuredCalls: measured.length, totalCalls: usages.length,
    hitRate: measuredInputTokens > 0 ? cachedInputTokens / measuredInputTokens : null };
}
