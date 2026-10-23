import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@harness/protocol";
import { ApprovalBroker } from "../packages/core/src/approvals.js";

const brokers: ApprovalBroker[] = [];
afterEach(() => { brokers.splice(0).forEach(broker => broker.close()); vi.useRealTimers(); });

function fixture() {
  const rows = new Map<string, ApprovalRequest>();
  const saveApproval = vi.fn((approval: ApprovalRequest) => { rows.set(approval.id, structuredClone(approval)); });
  const broker = new ApprovalBroker({
    saveApproval,
    getApproval: id => rows.get(id),
  });
  brokers.push(broker);
  function request(runId: string) {
    const controller = new AbortController();
    return { controller, ...broker.request({
      runId, toolName: "read_file", normalizedInput: { path: "source.txt" }, risk: "read", reason: "Fixture approval",
      requestedGrant: { toolNames: ["read_file"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "read" },
    }, controller.signal) };
  }
  return { broker, rows, request, saveApproval };
}

describe("pause preserves pending approvals while releasing execution waiters", () => {
  it("keeps pending status, deadline and identity while leaving other runs and decisions alone", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const first = request("paused"), second = request("paused"), decided = request("paused"), other = request("other");
    broker.decide(decided.approval.id, true, "fixture:user");
    broker.suspendRun("paused");
    expect(await first.decision).toBe(false);
    expect(await second.decision).toBe(false);
    expect(await decided.decision).toBe(true);
    expect(first.controller.signal.aborted).toBe(false);
    expect(rows.get(first.approval.id)).toEqual(first.approval);
    expect(rows.get(second.approval.id)).toEqual(second.approval);
    expect(rows.get(first.approval.id)?.decidedBy).toBeUndefined();
    expect(rows.get(decided.approval.id)).toMatchObject({ status: "approved", decidedBy: "fixture:user" });
    expect(rows.get(other.approval.id)?.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(3);
    first.controller.abort(); second.controller.abort();
    expect(rows.get(first.approval.id)?.status).toBe("pending");
    broker.decide(other.approval.id, true, "fixture:user");
    expect(await other.decision).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("reattaches the same approval on every resume without replacing the deadline", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const waiting = request("paused");
    broker.suspendRun("unknown");
    expect(rows.get(waiting.approval.id)?.status).toBe("pending");
    broker.suspendRun("paused");
    broker.suspendRun("paused");
    waiting.controller.abort();
    expect(await waiting.decision).toBe(false);
    expect(rows.get(waiting.approval.id)).toEqual(waiting.approval);
    const resumedSignal = new AbortController();
    const resumed = broker.reattach(waiting.approval.id, resumedSignal.signal);
    expect(resumed.approval).toEqual(waiting.approval);
    expect(vi.getTimerCount()).toBe(1);
    broker.suspendRun("paused");
    expect(await resumed.decision).toBe(false);
    const again = broker.reattach(waiting.approval.id, new AbortController().signal);
    broker.decide(waiting.approval.id, true, "fixture:user");
    expect(await again.decision).toBe(true);
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "approved", decidedBy: "fixture:user", expiresAt: waiting.approval.expiresAt });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records an explicit decision while suspended without waking an execution until reattached", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const waiting = request("paused");
    broker.suspendRun("paused");
    expect(await waiting.decision).toBe(false);
    broker.decide(waiting.approval.id, true, "fixture:user");
    waiting.controller.abort();
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "approved", decidedBy: "fixture:user" });
    expect(await broker.reattach(waiting.approval.id, new AbortController().signal).decision).toBe(true);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await broker.reattach(waiting.approval.id, cancelled.signal).decision).toBe(false);
    expect(rows.get(waiting.approval.id)?.status).toBe("approved");
  });

  it("honors the original expiry while paused and never revives it on resume", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const waiting = request("paused");
    broker.suspendRun("paused");
    expect(await waiting.decision).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "expired", decidedBy: "system:expired" });
    expect(await broker.reattach(waiting.approval.id, new AbortController().signal).decision).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps actual cancellation separate from pause and listens only to the resumed signal", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const waiting = request("paused");
    broker.suspendRun("paused");
    const controller = new AbortController();
    const resumed = broker.reattach(waiting.approval.id, controller.signal);
    waiting.controller.abort();
    expect(rows.get(waiting.approval.id)?.status).toBe("pending");
    controller.abort();
    expect(await resumed.decision).toBe(false);
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "denied", decidedBy: "system:cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a suspended request durable across broker shutdown and reattachment", async () => {
    vi.useFakeTimers();
    const { broker, rows, request, saveApproval } = fixture();
    const waiting = request("paused");
    broker.suspendRun("paused"); broker.close();
    expect(await waiting.decision).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const restarted = new ApprovalBroker({ saveApproval, getApproval: id => rows.get(id) }); brokers.push(restarted);
    const restored = restarted.reattach(waiting.approval.id, new AbortController().signal);
    expect(restored.approval).toEqual(waiting.approval);
    restarted.decide(waiting.approval.id, false, "fixture:user");
    expect(await restored.decision).toBe(false);
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "denied", decidedBy: "fixture:user" });
  });

  it("cleans up a waiter whose approval was removed by a withdrawal", async () => {
    vi.useFakeTimers();
    const { broker, rows, request, saveApproval } = fixture();
    const waiting = request("withdrawn");
    rows.delete(waiting.approval.id);
    waiting.controller.abort();
    expect(await waiting.decision).toBe(false);
    expect(rows.has(waiting.approval.id)).toBe(false);
    expect(saveApproval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => broker.reattach(waiting.approval.id, new AbortController().signal)).toThrow("Unknown approval");
  });
});

describe("pending-only decisions at the transport boundary", () => {
  it.each([true, false])("settles a pending approval once and preserves its first decision on every retry (%s)", async approved => {
    vi.useFakeTimers();
    const { broker, rows, request, saveApproval } = fixture();
    const waiting = request("run");
    const settled = broker.decideIfPending(waiting.approval.id, approved, "fixture:first");
    expect(settled).toMatchObject({ status: approved ? "approved" : "denied", decidedBy: "fixture:first" });
    expect(await waiting.decision).toBe(approved);
    expect(saveApproval).toHaveBeenCalledTimes(2);
    expect(broker.decideIfPending(waiting.approval.id, approved, "fixture:same-retry")).toBe(settled);
    expect(broker.decideIfPending(waiting.approval.id, !approved, "fixture:opposite-retry")).toBe(settled);
    waiting.controller.abort();
    expect(rows.get(waiting.approval.id)).toEqual(settled);
    expect(saveApproval).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => broker.decide(waiting.approval.id, !approved, "fixture:strict")).toThrow(`already ${settled.status}`);
  });

  it("returns an explicit denial unchanged when a stale client tries to approve it", async () => {
    vi.useFakeTimers();
    const { broker, rows, request, saveApproval } = fixture();
    const waiting = request("paused");
    broker.decide(waiting.approval.id, false, "fixture:user");
    expect(await waiting.decision).toBe(false);
    const denied = rows.get(waiting.approval.id)!;
    expect(broker.decideIfPending(waiting.approval.id, true, "desktop:user")).toBe(denied);
    expect(broker.decideIfPending(waiting.approval.id, false, "desktop:user")).toBe(denied);
    expect(denied).toMatchObject({ status: "denied", decidedBy: "fixture:user" });
    expect(saveApproval).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an expired decision unchanged instead of reviving it on a later approval", async () => {
    vi.useFakeTimers();
    const { broker, rows, request, saveApproval } = fixture();
    const waiting = request("expired");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(await waiting.decision).toBe(false);
    const expired = rows.get(waiting.approval.id)!;
    expect(expired).toMatchObject({ status: "expired", decidedBy: "system:expired" });
    expect(broker.decideIfPending(waiting.approval.id, true, "desktop:user")).toBe(expired);
    expect(broker.decideIfPending(waiting.approval.id, false, "desktop:user")).toBe(expired);
    expect(saveApproval).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not approve a pending record whose deadline passed before its timer callback", async () => {
    vi.useFakeTimers();
    const { broker, request } = fixture();
    const waiting = request("deadline");
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(broker.decideIfPending(waiting.approval.id, true, "desktop:user").status).toBe("expired");
    expect(await waiting.decision).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps unknown approvals as errors without creating a decision", () => {
    const { broker, saveApproval } = fixture();
    expect(() => broker.decideIfPending("unknown", true, "desktop:user")).toThrow("Unknown approval: unknown");
    expect(saveApproval).not.toHaveBeenCalled();
  });
});
