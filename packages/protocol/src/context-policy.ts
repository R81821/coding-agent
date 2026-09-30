/** Normalize persisted legacy ratios before strict validation; never mutate active run snapshots. */
export function migrateContextPolicy(stored: unknown): unknown {
  if (!stored || typeof stored !== "object") return stored;
  const profile = stored as Record<string, unknown>;
  if (!profile.contextPolicy || typeof profile.contextPolicy !== "object") return stored;
  const policy = profile.contextPolicy as Record<string, unknown>;
  const trigger = policy.compactAtRatio;
  const target = policy.maxAfterCompactionRatio;
  if (typeof trigger !== "number" || typeof target !== "number" || target < trigger) return stored;
  // Leave malformed numeric values to schema validation rather than silently repairing corruption.
  if (!Number.isFinite(trigger) || trigger < 0.5 || trigger > 0.9 || !Number.isFinite(target) || target < 0.1 || target > 0.9) return stored;
  const legacy = trigger === 0.7 && target === 0.8;
  return {
    ...profile,
    contextPolicy: { ...policy, compactAtRatio: legacy ? 0.8 : trigger, maxAfterCompactionRatio: Math.min(0.45, trigger - 0.1) },
    contextPolicyMigration: { version: 1, reason: legacy ? "legacy_defaults" : "invalid_saved_config", previous: policy },
  };
}
