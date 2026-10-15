import { describe, expect, it } from "vitest";
import { DaemonRequestSchema } from "@harness/protocol";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

describe("conversation task RPC boundary", () => {
  const identity = { sessionId: "session-a", parentRunId: "run-a", taskId: "task-a" };
  it("allows queue reads scoped to the selected conversation", () => {
    for (const params of [{ sessionId: identity.sessionId }, { sessionId: identity.sessionId, parentRunId: identity.parentRunId }]) {
      const request = sanitizeRendererRequest("conversationTasks.list", params);
      expect(DaemonRequestSchema.parse({ id: "list", ...request })).toMatchObject({ method: "conversationTasks.list", params });
    }
  });
  it("preserves every task identity and the trimmed retry reason", () => {
    const cancel = sanitizeRendererRequest("conversationTasks.cancel", identity);
    expect(DaemonRequestSchema.parse({ id: "cancel", ...cancel })).toMatchObject({ params: identity });
    const retry = sanitizeRendererRequest("conversationTasks.retry", { ...identity, reason: "  已检查上次产物  " });
    expect(DaemonRequestSchema.parse({ id: "retry", ...retry })).toMatchObject({ params: { ...identity, reason: "已检查上次产物" } });
  });
  it.each(["sessionId", "parentRunId", "taskId"])("rejects mutations without a valid %s", key => {
    for (const method of ["conversationTasks.cancel", "conversationTasks.retry"]) {
      const params = { ...identity, reason: "已核对", [key]: "" };
      expect(() => DaemonRequestSchema.parse({ id: "bad", ...sanitizeRendererRequest(method, params) })).toThrow();
      delete (params as Record<string, unknown>)[key];
      expect(() => DaemonRequestSchema.parse({ id: "bad", ...sanitizeRendererRequest(method, params) })).toThrow();
    }
  });
  it.each([undefined, "", "   ", "x".repeat(4001)])("rejects an absent, blank or excessive retry reason", reason => {
    expect(() => DaemonRequestSchema.parse({ id: "bad", ...sanitizeRendererRequest("conversationTasks.retry", { ...identity, reason }) })).toThrow();
  });
  it("keeps arbitrary queue and scheduler operations outside the renderer allowlist", () => {
    for (const method of ["conversationTasks.submit", "conversationTasks.claim", "conversationTasks.complete", "conversationTasks.transition"]) {
      expect(() => sanitizeRendererRequest(method, identity)).toThrow("cannot invoke");
    }
  });
});
