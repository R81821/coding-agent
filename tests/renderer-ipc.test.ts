import { describe, expect, it } from "vitest";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

describe("sanitizeRendererRequest", () => {
  it("allows whitelisted methods", () => {
    expect(sanitizeRendererRequest("run.start", { id: "r1" }).method).toBe("run.start");
  });

  it("rejects non-whitelisted methods", () => {
    expect(() => sanitizeRendererRequest("trace.export", {})).toThrow("cannot invoke");
  });

  it("forces the actor to desktop:user on approval.decide", () => {
    const result = sanitizeRendererRequest("approval.decide", { approvalId: "a1", approved: true, actor: "attacker" });
    expect(result.params).toEqual({ approvalId: "a1", approved: true, actor: "desktop:user" });
  });

  it("forces the actor to desktop:user on plan.decide and keeps feedback", () => {
    const result = sanitizeRendererRequest("plan.decide", { planId: "p1", version: 1, approved: false, actor: "attacker", feedback: "revise" });
    expect(result.params).toMatchObject({ actor: "desktop:user", feedback: "revise" });
  });
});
