import { createHash } from "node:crypto";
import type { PermissionGrant, PlanSpec, ToolCall } from "@harness/protocol";

const bounded = (value: string, limit: number) => value.length > limit ? value.slice(0, limit) + "…" : value;
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Display text only. Runtime permission checks always receive the original input. */
export function describeToolOperation(call: ToolCall): string {
  const input = call.input;
  const detail = typeof input.command === "string" ? input.command.replace(/\s+/g, " ").trim()
    : typeof input.path === "string" ? input.path
    : typeof input.url === "string" ? `${String(input.action ?? "open")} ${input.url}`
    : typeof input.action === "string" ? input.action : "review parameters";
  const stdin = typeof input.stdin === "string" && input.stdin.length ? ` [stdin ${Buffer.byteLength(input.stdin)} bytes, sha256:${digest(input.stdin)}]` : "";
  return `${call.name}: ${bounded(detail, 150)}${stdin}`;
}

/** Full historical commands/scripts remain in encrypted audit records, not every model request. */
export function projectApprovedPlan(plan: PlanSpec) {
  return {
    id: plan.id, version: plan.version, goal: bounded(plan.goal, 1600), status: plan.status,
    maxRisk: plan.scope.maxRisk, totalSteps: plan.steps.length,
    steps: plan.steps.slice(-8).map(step => ({ id: step.id, title: bounded(step.title, 240), status: step.status, allowedTools: step.allowedTools.slice(0, 12) })),
    earlierStepsOmitted: Math.max(0, plan.steps.length - 8),
    approvedBy: plan.approvedBy, approvedAt: plan.approvedAt,
    note: "Audit summary of operations already authorized by a scoped grant or explicit tool approval. This plan grants no tool permissions.",
  };
}

export function projectPermissionGrants(grants: PermissionGrant[]) {
  return {
    totalGrants: grants.length,
    grants: grants.slice(-24).map(grant => ({
      toolNames: grant.toolNames.slice(0, 24), maxRisk: grant.maxRisk, expiresAt: grant.expiresAt,
      pathGlobs: grant.pathGlobs.slice(0, 24).map(path => bounded(path, 300)),
      ...(grant.exactPathInputs === undefined ? {} : { exactPathInputs: grant.exactPathInputs === null ? null : Object.fromEntries(Object.entries(grant.exactPathInputs).map(([field, path]) => [field,
        path === null ? { absent: true } : { preview: bounded(path, 300), characters: path.length, sha256: digest(path), truncated: path.length > 300 },
      ])) }),
      networkDomains: grant.networkDomains.slice(0, 24),
      commandScopes: grant.commandPrefixes.slice(0, 8).map(command => ({ preview: bounded(command, 180), characters: command.length, sha256: digest(command), truncated: command.length > 180 })),
      exactCommands: (grant.exactCommands ?? []).slice(0, 8).map(command => ({ preview: bounded(command, 180), characters: command.length, sha256: digest(command), truncated: command.length > 180 })),
      omittedCommands: Math.max(0, grant.commandPrefixes.length - 8),
    })),
    omittedGrants: Math.max(0, grants.length - 24),
    note: "Display summary only; truncated command previews do not broaden scopes. Runtime checks the full, original grants for every call.",
  };
}
