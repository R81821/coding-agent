import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, DaemonRequestSchema, SessionViewCache, mergeViewPage, mergeViewEvents, refreshSessionView, type RunSpec, type SessionView } from "@harness/protocol";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
const at = "2026-10-05T00:00:00.000Z";
function view(id = "session"): SessionView {
  return { session: { id, title: id, workspacePath: "D:/fixture", profileId: "default", createdAt: at, updatedAt: at }, runs: [], hasMore: false };
}
function spec(n: number, sessionId = "session"): RunSpec {
  return { id: `run-${String(n).padStart(3, "0")}`, sessionId, request: "private request", workspacePath: "D:/fixture", profileId: "default", attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: at };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-session-view-"));
  const crypto = await VaultCrypto.open(join(root, "envelope.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(root, "test.sqlite"), crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  database.createSession(view().session);
  return { database, crypto };
}

describe("bounded display reads", () => {
  it("pages equal-time turns without overlap and leaves the engine's full history intact", async () => {
    const { database, crypto } = await fixture();
    for (let n = 0; n < 45; n++) {
      database.saveRun(spec(n), "completed");
      database.appendEvent({ id: `result-${n}`, runId: spec(n).id, sequence: 0, at, type: "result", status: "completed", text: "x".repeat(18000) });
    }
    const decrypt = vi.spyOn(crypto, "decryptJson");
    const first = database.getSessionView("session")!;
    expect(first.runs).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.runs[0]!.spec.id).toBe("run-025");
    expect(decrypt.mock.calls.length).toBeLessThanOrEqual(42);
    expect(first.runs[0]!.events[0]).toMatchObject({ text: "x".repeat(18000) });
    const second = database.getSessionView("session", 20, first.before)!;
    const third = database.getSessionView("session", 20, second.before)!;
    expect(third.runs).toHaveLength(5);
    expect(third.hasMore).toBe(false);
    expect(new Set([...first.runs, ...second.runs, ...third.runs].map(run => run.spec.id)).size).toBe(45);
    const full = database.getSessionDetail("session")!;
    expect(full.runs).toHaveLength(45);
    expect(full.runs[0]!.events[0]).toMatchObject({ text: "x".repeat(18000) });
  });

  it("does not load content objects for previews or event pages, but provides paginated output on demand", async () => {
    const { database, crypto } = await fixture();
    const run = spec(1); database.saveRun(run, "completed");
    const output = "private-tool-output-".repeat(6000);
    database.appendEvent({ id: "tool", runId: run.id, sequence: 0, at, type: "tool_finished", callId: "call", durationMs: 1, output });
    database.appendEvent({ id: "result", runId: run.id, sequence: 1, at, type: "result", status: "completed", text: "answer" });
    const decrypt = vi.spyOn(crypto, "decryptJson");
    expect(database.getSessionView("session")!.runs[0]!.events).toHaveLength(1);
    const first = database.listEventPage(run.id, -1, 1);
    expect(first).toMatchObject({ nextSequence: 0, hasMore: true, status: "completed" });
    expect(first.events[0]).toMatchObject({ output: { deferred: true, runId: run.id, callId: "call" } });
    expect(decrypt.mock.calls.some(call => String(call[1]).startsWith("content:"))).toBe(false);
    expect(database.listEventPage(run.id, first.nextSequence, 1)).toMatchObject({ nextSequence: 1, hasMore: false });
    const chunk = database.getOutputPage(run.id, "call", 0, 16000);
    expect(chunk).toEqual({ text: output.slice(0, 16000), nextOffset: 16000, hasMore: true });
    decrypt.mockClear();
    expect(database.getOutputPage(run.id, "call", chunk.nextOffset, 64000).text).toBe(output.slice(16000, 80000));
    expect(decrypt.mock.calls.some(call => String(call[1]).startsWith("content:"))).toBe(false);
    expect(database.listEvents(run.id)[0]).toMatchObject({ output });
  });

  it("flushes streaming deltas before reading the display cursor and supports resume after a result", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "old-result", runId: run.id, sequence: 0, at, type: "result", status: "paused", text: "old answer" });
    database.appendEvent({ id: "delta", runId: run.id, sequence: 1, at, type: "text_delta", delta: "new answer" });
    const initial = database.getSessionView("session")!.runs[0]!;
    expect(initial.view?.lastSequence).toBe(1);
    expect(initial.events.at(-1)).toMatchObject({ delta: "new answer" });
    database.appendEvent({ id: "delta2", runId: run.id, sequence: 2, at, type: "text_delta", delta: " continued" });
    expect(database.listEventPage(run.id, 1)).toMatchObject({ nextSequence: 2, status: "running", events: [{ sequence: 2 }] });
  });

  it("decrypts only the requested sidebar page and computes counts without decoding runs", async () => {
    const { database, crypto } = await fixture();
    for (let n = 0; n < 60; n++) {
      database.createSession(view(`session-${n}`).session);
      database.saveRun(spec(n, `session-${n}`), "completed");
    }
    const decrypt = vi.spyOn(crypto, "decryptJson");
    const page = database.listSessions({ deleted: false, limit: 10, offset: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.items.every(item => item.runCount === 1 && item.latestStatus === "completed")).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(decrypt).toHaveBeenCalledTimes(10);
    expect(decrypt.mock.calls.every(call => String(call[1]).startsWith("sessions:"))).toBe(true);
  });

  it("returns all streaming text beyond 100 deltas and 16000 characters", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    for (let sequence = 0; sequence < 120; sequence++) database.appendEvent({ id: `delta-${sequence}`, runId: run.id, at, sequence, type: "text_delta", delta: "x".repeat(200) });
    expect(database.getSessionView("session")!.runs[0]!.events.at(-1)).toMatchObject({ delta: "x".repeat(24000) });
  });

  it("denies all display endpoints for deleted sessions or projects", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "completed");
    database.deleteSession("session");
    expect(database.getSessionView("session")).toBeUndefined();
    expect(() => database.listEventPage(run.id)).toThrow(/删除/);
    expect(() => database.getOutputPage(run.id, "call")).toThrow(/删除/);
    database.restoreSession("session");
    database.deleteProject(database.listProjects()[0]!.id);
    expect(database.getSessionView("session")).toBeUndefined();
    expect(database.listSessions({ deleted: false }).items).toHaveLength(0);
    expect(() => database.listEventPage(run.id)).toThrow(/删除/);
  });
});

describe("display cache and incremental merges", () => {
  it("keeps the same view for empty polls, but propagates terminal status changes", () => {
    const initial: SessionView = { ...view(), runs: [{ spec: spec(1), status: "running", events: [], view: { lastSequence: 5, eventsComplete: false } }] };
    const page = { events: [], nextSequence: 5, status: "running" as const, hasMore: false };
    expect(mergeViewEvents(initial, spec(1).id, page)).toBe(initial);
    expect(mergeViewEvents(initial, "unrelated", page)).toBe(initial);
    const done = mergeViewEvents(initial, spec(1).id, { ...page, status: "completed" });
    expect(done).not.toBe(initial);
    expect(done.runs[0]?.status).toBe("completed");
  });
  it("enforces both LRU and byte bounds, rejects deleted entries and clears decrypted data", () => {
    const cache = new SessionViewCache(2, 2000);
    cache.set(view("a")); cache.set(view("b")); cache.get("a"); cache.set(view("c"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    cache.set({ ...view("a"), session: { ...view("a").session, title: "x".repeat(3000) } });
    expect(cache.get("a")).toBeUndefined();
    cache.set({ ...view("deleted"), session: { ...view("deleted").session, deletedAt: at } });
    expect(cache.get("deleted")).toBeUndefined();
    cache.clear(); expect(cache.get("c")).toBeUndefined();
  });

  it("keeps loaded earlier turns through revalidation and ignores pages for another session", () => {
    const run = (n: number) => ({ spec: spec(n), status: "completed" as const, events: [] });
    const latest = { ...view(), runs: [run(3)], hasMore: true, before: { createdAt: at, id: "run-003" } };
    const older = { ...view(), runs: [run(1), run(2)], hasMore: false, before: { createdAt: at, id: "run-001" } };
    const merged = mergeViewPage(latest, older);
    expect(merged.runs.map(run => run.spec.id)).toEqual(["run-001", "run-002", "run-003"]);
    expect(refreshSessionView(merged, latest)).toMatchObject({ hasMore: false, before: older.before, runs: merged.runs });
    expect(mergeViewPage(merged, view("other"))).toBe(merged);
  });

  it("drains terminal event pages before ending a live subscription and deduplicates sequence numbers", () => {
    const initial: SessionView = { ...view(), runs: [{ spec: spec(1), status: "running", events: [], view: { lastSequence: -1, eventsComplete: true } }] };
    const page = { events: [{ id: "r", runId: spec(1).id, at, sequence: 1, type: "result" as const, status: "completed" as const, text: "answer" }], nextSequence: 1, status: "completed" as const, hasMore: true };
    const partial = mergeViewEvents(initial, spec(1).id, page);
    expect(partial.runs[0]!.status).toBe("running");
    const done = mergeViewEvents(partial, spec(1).id, { ...page, hasMore: false });
    expect(done.runs[0]!.status).toBe("completed");
    expect(done.runs[0]!.events).toHaveLength(1);
  });

  it("caps request sizes at the RPC boundary", () => {
    for (const request of [
      { method: "session.view", params: { sessionId: "s", limit: 21 } },
      { method: "run.eventPage", params: { runId: "r", limit: 201 } },
      { method: "run.output", params: { runId: "r", callId: "c", offset: -1 } },
    ]) expect(DaemonRequestSchema.safeParse({ id: "request", ...request }).success).toBe(false);
  });
});
