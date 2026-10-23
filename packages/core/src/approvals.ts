import type { ApprovalRequest, PermissionGrant, RiskLevel } from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";

export interface ApprovalRepository {
  saveApproval(approval: ApprovalRequest): void;
  getApproval(id: string): ApprovalRequest | undefined;
}

interface PendingApproval {
  runId: string;
  resolve?: ((approved: boolean) => void) | undefined;
  detach?: (() => void) | undefined;
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
    return { approval, decision: this.wait(approval, signal) };
  }

  /** Reattach a resumed run to its original persisted decision and deadline. */
  reattach(id: string, signal: AbortSignal): { approval: ApprovalRequest; decision: Promise<boolean> } {
    const approval = this.repository.getApproval(id);
    if (!approval) throw new Error(`Unknown approval: ${id}`);
    return { approval, decision: this.wait(approval, signal) };
  }

  private wait(approval: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (approval.status !== "pending") return Promise.resolve(!signal.aborted && approval.status === "approved");
    const existing = this.pending.get(approval.id);
    if (existing?.resolve) throw new Error(`Approval ${approval.id} already has a waiting execution`);
    return new Promise<boolean>(resolveDecision => {
      const pending = existing ?? { runId: approval.runId, timeout: setTimeout(() => this.finish(approval.id, false, "system:expired"), Math.max(1, Date.parse(approval.expiresAt) - Date.now())) };
      pending.resolve = resolveDecision;
      const abort = () => this.finish(approval.id, false, "system:cancelled");
      pending.detach = () => signal.removeEventListener("abort", abort);
      this.pending.set(approval.id, pending);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (Date.parse(approval.expiresAt) <= Date.now()) this.finish(approval.id, false, "system:expired");
    });
  }

  decide(id: string, approved: boolean, actor: string): ApprovalRequest {
    const approval = this.repository.getApproval(id);
    if (!approval) throw new Error(`Unknown approval: ${id}`);
    if (approval.status !== "pending") throw new Error(`Approval ${id} is already ${approval.status}`);
    this.finish(id, approved, actor);
    return this.repository.getApproval(id) ?? approval;
  }

  /** A transport retry returns the settled decision without changing it or releasing a tool twice. */
  decideIfPending(id: string, approved: boolean, actor: string): ApprovalRequest {
    const approval = this.repository.getApproval(id);
    if (approval && approval.status !== "pending") return approval;
    return this.decide(id, approved, actor);
  }

  /** Unwind the execution boundary while leaving the user's undecided request intact. */
  suspendRun(runId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.runId !== runId) continue;
      pending.detach?.(); pending.detach = undefined;
      const resolve = pending.resolve; pending.resolve = undefined;
      resolve?.(false);
    }
  }

  /** Actual cancellation/denial is separate from a resumable pause. */
  denyRun(runId: string, actor = "system:cancelled"): void {
    for (const [id, pending] of this.pending) {
      if (pending.runId === runId) this.finish(id, false, actor);
    }
  }

  /** Stop local timers/listeners; a suspended approval remains durable for a later process. */
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout); pending.detach?.(); pending.resolve?.(false);
    }
    this.pending.clear();
  }

  private finish(id: string, approved: boolean, actor: string): void {
    const approval = this.repository.getApproval(id);
    if (!approval) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout); pending.detach?.(); pending.resolve?.(false);
        this.pending.delete(id);
      }
      return;
    }
    if (approval.status !== "pending") return;
    const expired = new Date(approval.expiresAt).getTime() <= Date.now();
    this.repository.saveApproval({ ...approval, status: expired ? "expired" : approved ? "approved" : "denied", decidedBy: actor });
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.detach?.();
      pending.resolve?.(approved && !expired);
      this.pending.delete(id);
    }
  }
}

