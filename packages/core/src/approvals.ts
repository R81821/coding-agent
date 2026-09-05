import type { ApprovalRequest, PermissionGrant, RiskLevel } from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";

export interface ApprovalRepository {
  saveApproval(approval: ApprovalRequest): void;
  getApproval(id: string): ApprovalRequest | undefined;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly repository: ApprovalRepository) {}

  request(input: {
    runId: string;
    toolName: string;
    normalizedInput: Record<string, unknown>;
    risk: RiskLevel;
    reason: string;
    requestedGrant: PermissionGrant;
    ttlMs?: number;
  }, signal: AbortSignal): { approval: ApprovalRequest; decision: Promise<boolean> } {
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    const approval: ApprovalRequest = {
      id: newId("approval"),
      runId: input.runId,
      toolName: input.toolName,
      normalizedInput: input.normalizedInput,
      risk: input.risk,
      reason: input.reason,
      requestedGrant: input.requestedGrant,
      status: "pending",
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    };
    this.repository.saveApproval(approval);
    const decision = new Promise<boolean>((resolveDecision) => {
      const timeout = setTimeout(() => this.finish(approval.id, false, "system:expired"), ttlMs);
      this.pending.set(approval.id, { resolve: resolveDecision, timeout });
      signal.addEventListener("abort", () => this.finish(approval.id, false, "system:cancelled"), { once: true });
    });
    return { approval, decision };
  }

  decide(id: string, approved: boolean, actor: string): ApprovalRequest {
    const approval = this.repository.getApproval(id);
    if (!approval) throw new Error(`Unknown approval: ${id}`);
    if (approval.status !== "pending") throw new Error(`Approval ${id} is already ${approval.status}`);
    this.finish(id, approved, actor);
    return this.repository.getApproval(id) ?? approval;
  }

  private finish(id: string, approved: boolean, actor: string): void {
    const approval = this.repository.getApproval(id);
    if (!approval || approval.status !== "pending") return;
    const expired = new Date(approval.expiresAt).getTime() <= Date.now();
    this.repository.saveApproval({ ...approval, status: expired ? "expired" : approved ? "approved" : "denied", decidedBy: actor });
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(approved && !expired);
      this.pending.delete(id);
    }
  }
}

