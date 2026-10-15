import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@harness/protocol";
import { ApprovalBroker } from "../packages/core/src/approvals.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const rows = new Map<string, ApprovalRequest>();
  const broker = new ApprovalBroker({
    saveApproval: approval => { rows.set(approval.id, structuredClone(approval)); },
    getApproval: id => rows.get(id),
  });
  function request(runId: string) {
    const controller = new AbortController();
    return { controller, ...broker.request({
      runId, toolName: "read_file", normalizedInput: { path: "source.txt" }, risk: "read", reason: "Fixture approval",
      requestedGrant: { toolNames: ["read_file"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "read" },
    }, controller.signal) };
  }
  return { broker, rows, request };
}

describe("pause releases only the run's pending tool approvals", () => {
  it("denies every waiting call of the paused run, preserves other runs and already decided approvals", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const first = request("paused"), second = request("paused"), decided = request("paused"), other = request("other");
    broker.decide(decided.approval.id, true, "fixture:user");
    broker.denyRun("paused");
    expect(await first.decision).toBe(false);
    expect(await second.decision).toBe(false);
    expect(await decided.decision).toBe(true);
    expect(first.controller.signal.aborted).toBe(false);
    expect(rows.get(first.approval.id)).toMatchObject({ status: "denied", decidedBy: "system:paused" });
    expect(rows.get(decided.approval.id)).toMatchObject({ status: "approved", decidedBy: "fixture:user" });
    expect(rows.get(other.approval.id)?.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    broker.decide(other.approval.id, true, "fixture:user");
    expect(await other.decision).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => broker.decide(first.approval.id, true, "fixture:user")).toThrow("already denied");
  });

  it("is idempotent for an unknown or settled run and keeps a denied call denied after cancellation", async () => {
    vi.useFakeTimers();
    const { broker, rows, request } = fixture();
    const waiting = request("paused");
    broker.denyRun("unknown");
    expect(rows.get(waiting.approval.id)?.status).toBe("pending");
    broker.denyRun("paused");
    broker.denyRun("paused");
    waiting.controller.abort();
    expect(await waiting.decision).toBe(false);
    expect(rows.get(waiting.approval.id)).toMatchObject({ status: "denied", decidedBy: "system:paused" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
