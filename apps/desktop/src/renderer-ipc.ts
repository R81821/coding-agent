import type { DaemonRequest } from "@harness/protocol";

/** Daemon methods the renderer may invoke. Anything else is rejected at the IPC boundary. */
const RENDERER_ALLOWED_METHODS: ReadonlySet<DaemonRequest["method"]> = new Set([
  "health",
  "run.start",
  "runs.list",
  "run.get",
  "run.resume",
  "run.cancel",
  "run.events",
  "plan.get",
  "plan.decide",
  "checkpoints.get",
  "approvals.list",
  "approval.decide",
  "tasks.list",
  "tasks.upsert",
  "profiles.list",
  "memory.list",
  "memory.decide",
  "memory.update",
  "memory.delete",
  "profiles.memoryScopes",
  "skills.list",
  "skills.trust",
  "skills.untrust",
  "plugins.list",
  "plugins.install",
  "plugins.trust",
  "plugins.enable",
  "plugins.disable",
  "search.status",
  "trace.query",
  "project.inspect",
  "project.trust",
  "connectors.pairing",
  "attachment.put",
]);

/**
 * Validate a renderer-originated daemon request: restrict the method set and
 * force the actor on approval decisions so the UI cannot impersonate another actor.
 */
export function sanitizeRendererRequest(
  method: string,
  params: unknown,
): { method: DaemonRequest["method"]; params: unknown } {
  if (!RENDERER_ALLOWED_METHODS.has(method as DaemonRequest["method"])) {
    throw new Error(`Renderer cannot invoke daemon method: ${method}`);
  }
  if (["approval.decide", "plan.decide", "memory.decide", "memory.update"].includes(method)) {
    return {
      method: method as DaemonRequest["method"],
      params: { ...(params as Record<string, unknown>), actor: "desktop:user" },
    };
  }
  return { method: method as DaemonRequest["method"], params };
}
