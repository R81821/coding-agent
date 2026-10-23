import { expect, it } from "vitest";
import { createSessionTurnSelector, eligibleWithdrawalRun, latestConversationRun, latestSessionRun, sessionTurns } from "./run-history.js";
import type { SessionDetail } from "@harness/protocol";

it("selects the newest historical run by creation time", () => {
  const makeRun = (id: string, createdAt: string) => ({
    spec: { id, createdAt },
  } as SessionDetail["runs"][number]);
  const latest = latestSessionRun([
    makeRun("older", "2026-09-22T10:00:00.000Z"),
    makeRun("newer", "2026-09-22T10:03:00.000Z"),
  ]);
  expect(latest?.spec.id).toBe("newer");
});

it("preserves parent-run metadata in full and preview session turns", () => {
  for (const eventsComplete of [true, false]) {
    const detail = { runs: [{
      spec: { id: "child", request: "subtask", createdAt: "2026-10-11T03:00:00.000Z", parentRunId: "parent" },
      status: "completed", events: [], view: { lastSequence: 10, eventsComplete }
    }] } as unknown as SessionDetail;
    expect(sessionTurns(detail)[0]).toMatchObject({ runId: "child", parentRunId: "parent" });
  }
});

it("keeps sent screenshots in both preview and complete history rows and refreshes changed attachments", () => {
  const image = { id: "screenshot", mimeType: "image/png", sha256: "a".repeat(64), fileName: "截图.png" };
  for (const eventsComplete of [true, false]) {
    const detail = { runs: [{ spec: { id: "run", request: "查看截图", createdAt: "2026-10-20T00:00:00.000Z", attachments: [image] },
      status: "completed", events: [], view: { lastSequence: 0, eventsComplete } }] } as unknown as SessionDetail;
    const select = createSessionTurnSelector();
    const original = select(detail)[0]!;
    expect(original.attachments).toBe(detail.runs[0]!.spec.attachments);
    expect(select(detail)[0]).toBe(original);
    const updated = select({ ...detail, runs: detail.runs.map(run => ({ ...run, spec: { ...run.spec, attachments: [] } })) })[0]!;
    expect(updated).not.toBe(original);
    expect(updated.attachments).toBeUndefined();
  }
});

it("refreshes a cached session turn if its parent-run metadata changes", () => {
  const select = createSessionTurnSelector();
  const detail = { runs: [{
    spec: { id: "run", request: "request", createdAt: "2026-10-11T03:00:00.000Z" },
    status: "completed", events: []
  }] } as unknown as SessionDetail;
  const original = select(detail)[0];
  expect(select(detail)[0]).toBe(original);
  const updated = select({ ...detail, runs: detail.runs.map(run => ({ ...run, spec: { ...run.spec, parentRunId: "parent" } })) })[0];
  expect(updated).not.toBe(original);
  expect(updated?.parentRunId).toBe("parent");
});

it("offers withdrawal for only the latest paused conversation round, ignoring newer child runs", () => {
  const detail = { runs: [
    { spec: { id: "older", createdAt: "2026-10-11T03:00:00.000Z" }, status: "paused" },
    { spec: { id: "latest", createdAt: "2026-10-11T03:01:00.000Z" }, status: "paused" },
    { spec: { id: "child", createdAt: "2026-10-11T03:02:00.000Z", parentRunId: "latest" }, status: "completed" }
  ] } as unknown as SessionDetail;
  expect(latestConversationRun(detail.runs)?.spec.id).toBe("latest");
  expect(eligibleWithdrawalRun(detail)?.spec.id).toBe("latest");
});

it("does not offer withdrawal for completed, active, approval-waiting or older rounds", () => {
  expect(eligibleWithdrawalRun(undefined)).toBeUndefined();
  expect(eligibleWithdrawalRun({ runs: [] } as unknown as SessionDetail)).toBeUndefined();
  for (const status of ["queued", "planning", "running", "waiting_approval", "verifying", "review", "completed", "failed", "cancelled"]) {
    const detail = { runs: [
      { spec: { id: "older-paused", createdAt: "2026-10-11T03:00:00.000Z" }, status: "paused" },
      { spec: { id: "newer", createdAt: "2026-10-11T03:01:00.000Z" }, status }
    ] } as unknown as SessionDetail;
    expect(eligibleWithdrawalRun(detail), status).toBeUndefined();
  }
  const children = { runs: [{ spec: { id: "child", parentRunId: "parent", createdAt: "2026-10-11T03:00:00.000Z" }, status: "paused" }] } as unknown as SessionDetail;
  expect(eligibleWithdrawalRun(children)).toBeUndefined();
});

it("offers only the latest paused human message with a saved recovery boundary", () => {
  const submitted = { id: "event1", runId: "run", at: "2026-10-15T00:00:00.000Z", sequence: 1, type: "steering_submitted", messageId: "message1", text: "correction", withdrawable: true };
  const detail = { runs: [{ spec: { id: "run", createdAt: "2026-10-15T00:00:00.000Z" }, status: "paused", events: [submitted] }] } as unknown as SessionDetail;
  expect(eligibleWithdrawalRun(detail)?.spec.id).toBe("run");
  for (const status of ["running", "completed"]) expect(eligibleWithdrawalRun({ ...detail, runs: detail.runs.map(run => ({ ...run, status })) } as SessionDetail)).toBeUndefined();
  const newer = { ...submitted, id: "event2", sequence: 2, messageId: "message2", withdrawable: false };
  const olderDelivered = { ...submitted, id: "event3", sequence: 3, type: "steering_delivered" };
  expect(eligibleWithdrawalRun({ ...detail, runs: detail.runs.map(run => ({ ...run, events: [submitted, newer, olderDelivered] })) } as unknown as SessionDetail)).toBeUndefined();
  for (const event of [{ ...submitted, withdrawable: undefined }, { ...submitted, type: "steering_delivered", messageId: undefined }]) {
    expect(eligibleWithdrawalRun({ ...detail, runs: detail.runs.map(run => ({ ...run, events: [event] })) } as unknown as SessionDetail)).toBeUndefined();
  }
});
