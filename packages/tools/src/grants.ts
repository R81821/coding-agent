import type { PermissionGrant, RiskLevel } from "@harness/protocol";

const riskRank: Record<RiskLevel, number> = { read: 0, write: 1, high: 2, destructive: 3 };

/**
 * Tools-layer half of the permission model: the engine decides which calls are
 * authorized, and tools verify that the call stays inside the granted scope.
 * Returns undefined when the call is allowed, otherwise a human-readable reason.
 * Tools with no matching grant entry are unaffected (the engine remains the gate;
 * an empty grants array — e.g. the default profile — applies no scope limits here).
 */
export function grantsAllow(
  toolName: string,
  grants: PermissionGrant[],
  input: Record<string, unknown>,
  risk: RiskLevel,
): string | undefined {
  if (risk === "read") return undefined;
  const now = Date.now();
  const relevant = grants.filter(
    (grant) =>
      (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now) &&
      grant.toolNames.includes(toolName) &&
      riskRank[risk] <= riskRank[grant.maxRisk],
  );
  if (relevant.length === 0) return undefined;
  const command = typeof input.command === "string" ? input.command.trim() : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  for (const grant of relevant) {
    if (command !== undefined && grant.commandPrefixes.length > 0 && !grant.commandPrefixes.some((prefix) => command.startsWith(prefix))) continue;
    if (url !== undefined && grant.networkDomains.length > 0) {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (!grant.networkDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    }
    return undefined;
  }
  return `No active grant covers ${toolName} with the requested scope`;
}
