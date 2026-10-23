import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@harness/protocol";
import { approvalDecisionNotice, createApprovalActionGuard } from "./approval-actions.js";

describe("approval actions and stale snapshots", () => {
  it("shares one synchronous lock across pause, dialog and approval-center actions", () => {
    const guard = createApprovalActionGuard();
    const before = guard.version;
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    expect(guard.isCurrent(before)).toBe(false);
    expect(guard.isCurrent(guard.version)).toBe(false);
    const during = guard.version;
    guard.end();
    expect(guard.isCurrent(before)).toBe(false);
    expect(guard.isCurrent(during)).toBe(false);
    expect(guard.isCurrent(guard.version)).toBe(true);
  });

  it("allows retry after a failed action while discarding its old pending snapshot", () => {
    const guard = createApprovalActionGuard();
    expect(guard.begin()).toBe(true);
    const stale = guard.version;
    guard.end();
    expect(guard.begin()).toBe(true);
    guard.end();
    expect(guard.isCurrent(stale)).toBe(false);
    expect(guard.isCurrent(guard.version)).toBe(true);
  });

  it("reports the saved decision without describing a denied or expired approval as approved", () => {
    const approval = { status: "denied", decidedBy: "system:paused" } as ApprovalRequest;
    expect(approvalDecisionNotice(approval, true)).toContain("拒绝");
    expect(approvalDecisionNotice(approval, false)).toBe("");
    expect(approvalDecisionNotice({ ...approval, decidedBy: "desktop:user" }, true)).toContain("拒绝");
    expect(approvalDecisionNotice({ ...approval, status: "expired", decidedBy: "system:expired" }, true)).toContain("过期");
    expect(approvalDecisionNotice({ ...approval, status: "approved", decidedBy: "desktop:user" }, true)).toBe("");
    expect(approvalDecisionNotice({ ...approval, status: "approved", decidedBy: "desktop:user" }, false)).toContain("已获批准");
  });
});
