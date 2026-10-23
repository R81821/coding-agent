import type { ApprovalRequest } from "@harness/protocol";

/** Shared by the dialog, approval center and pause action; older polls cannot reopen settled prompts. */
export function createApprovalActionGuard() {
  let version = 0;
  let busy = false;
  return {
    get version() { return version; },
    begin() { if (busy) return false; busy = true; version++; return true; },
    end() { busy = false; version++; },
    isCurrent(snapshot: number) { return !busy && snapshot === version; },
  };
}

export function approvalDecisionNotice(approval: ApprovalRequest, approved: boolean): string {
  if (approval.status === (approved ? "approved" : "denied")) return "";
  if (approval.status === "expired") return "该审批已过期，已同步最新状态。";
  if (approval.status === "denied") return "该审批已被拒绝，已保留原决定。";
  if (approval.status === "approved") return "该审批已获批准，已保留原决定。";
  return "该审批仍在等待处理，请重试。";
}
