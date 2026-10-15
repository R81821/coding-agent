import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, DaemonRequestSchema, SessionViewCache, isCommittedContextAdjustment, latestContextUsage, mergeViewPage, mergeViewEvents, refreshSessionView, type AgentEvent, type AgentEventInput, type ContextUsage, type RunSpec, type SessionView } from "@harness/protocol";
import { SessionCacheStats } from "../apps/desktop/src/components/SessionCacheStats.js";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { createElement } = desktopRequire("react") as typeof import("react");
const { renderToStaticMarkup } = desktopRequire("react-dom/server") as typeof import("react-dom/server");

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

  it("restores the latest context occupancy in previews and every update in event pages", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "context-before", runId: run.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 810_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "context-after", runId: run.id, sequence: 1, at, type: "context_usage", context: { usedTokens: 360_000, capacityTokens: 1_000_000, source: "estimate" } });
    expect(database.getSessionView("session")!.runs[0]!.events).toEqual([
      expect.objectContaining({ id: "context-before", context: { usedTokens: 810_000, capacityTokens: 1_000_000, source: "provider" } }),
      expect.objectContaining({ id: "context-after", context: { usedTokens: 360_000, capacityTokens: 1_000_000, source: "estimate" } }),
    ]);
    expect(database.listEventPage(run.id).events.map(event => event.id)).toEqual(["context-before", "context-after"]);
  });

  it.each([undefined, "main"] as const)("retains main input measurement with purpose %s through a new estimate and auxiliary requests", async purpose => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "measured", runId: run.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 490_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "main-usage", runId: run.id, sequence: 1, at, type: "usage", usage: { inputTokens: 489_000, outputTokens: 1_000, estimatedUsd: 0, ...(purpose ? { purpose } : {}) } });
    database.appendEvent({ id: "main-finished", runId: run.id, sequence: 2, at, type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 });
    database.appendEvent({ id: "preparing", runId: run.id, sequence: 3, at, type: "context_usage", context: { usedTokens: 1_000, capacityTokens: 1_000_000, source: "estimate" } });
    database.appendEvent({ id: "missing-main-input", runId: run.id, sequence: 4, at, type: "usage", usage: { inputTokens: 0, outputTokens: 50, estimatedUsd: 0, purpose: "main" } });
    for (let n = 0; n < 40; n++) {
      const auxiliaryPurpose = n % 2 ? "review" : "compaction";
      database.appendEvent({ id: `auxiliary-${n}`, runId: run.id, sequence: 5 + 2 * n, at, type: "usage", usage: { inputTokens: 12_000, outputTokens: 100, estimatedUsd: 0, purpose: auxiliaryPurpose } });
      database.appendEvent({ id: `auxiliary-finished-${n}`, runId: run.id, sequence: 6 + 2 * n, at, type: "model_request_finished", purpose: auxiliaryPurpose, succeeded: true, durationMs: 1 });
    }
    const preview = database.getSessionView("session")!.runs[0]!;
    expect(preview.events.map(event => event.id)).toEqual(["measured", "main-usage", "main-finished", "preparing"]);
    expect(preview.view?.lastSequence).toBe(84);
  });

  it("retains committed token adjustments behind character-only changes without loading the compaction summary or tools", async () => {
    const { database, crypto } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "measured", runId: run.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 810_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "commit", runId: run.id, sequence: 1, at, type: "context_compacted", record: {
      id: "compaction", runId: run.id, sourceSequenceStart: 0, sourceSequenceEnd: 0, summary: "private summary ".repeat(10_000), summaryHash: "hash", modelId: "fixture",
      inputTokens: 810_000, outputTokens: 1_000, deterministicFallback: false, summaryOutcome: "accepted", trust: "untrusted_tool", createdAt: at,
    } });
    database.appendEvent({ id: "compacted-estimate", runId: run.id, sequence: 2, at, type: "context_usage", context: { usedTokens: 360_000, capacityTokens: 1_000_000, source: "estimate" } });
    database.appendEvent({ id: "compacted-tokens", runId: run.id, sequence: 3, at, type: "context_adjusted", adjustment: { kind: "full_compaction", beforeTokens: 810_000, afterTokens: 360_000, capacityTokens: 1_000_000, summaryOutcome: "accepted" } });
    database.appendEvent({ id: "tool", runId: run.id, sequence: 4, at, type: "tool_finished", callId: "call", durationMs: 1, output: "private tool output ".repeat(10_000) });
    for (let n = 0; n < 80; n++) database.appendEvent({ id: `bounded-${n}`, runId: run.id, sequence: n + 5, at, type: "context_adjusted", adjustment: { kind: "tool_result_bound", beforeCharacters: 10_000, afterCharacters: 8_000 } });
    database.appendEvent({ id: "current-capacity", runId: run.id, sequence: 85, at, type: "context_adjusted", adjustment: { kind: "policy_migration", capacityTokens: 1_000_000 } });
    database.flushEvents();
    const decrypt = vi.spyOn(crypto, "decryptJson");
    const events = database.getSessionView("session")!.runs[0]!.events;
    expect(events.map(event => event.id)).toEqual(["measured", "compacted-estimate", "compacted-tokens", "current-capacity"]);
    expect(decrypt.mock.calls.some(call => ["event:run-001:1", "event:run-001:4"].includes(String(call[1])) || String(call[1]).startsWith("content:"))).toBe(false);
  });

  it.each([["provider-B", "model-A"], ["provider-A", "model-B"]])("does not borrow old context capacity after switching to %s/%s", async (providerId, modelId) => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "old-route", runId: run.id, sequence: 0, at, type: "route", providerId: "provider-A", modelId: "model-A", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "old-context", runId: run.id, sequence: 1, at, type: "context_usage", context: { usedTokens: 490_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "new-route", runId: run.id, sequence: 2, at, type: "route", providerId, modelId, reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "new-usage", runId: run.id, sequence: 3, at, type: "usage", usage: { inputTokens: 20_000, outputTokens: 2_000, estimatedUsd: 0, purpose: "main" } });
    const preview = database.getSessionView("session")!.runs[0]!.events;
    const canonical = database.getSessionDetail("session")!.runs[0]!.events;
    expect(preview.map(event => event.id)).toEqual(["old-route", "old-context", "new-route", "new-usage"]);
    expect(latestContextUsage(preview)).toEqual(latestContextUsage(canonical));
    expect(latestContextUsage(preview)).toBeUndefined();
  });

  it("keeps the current route's beginning when the same model is routed again after a measurement", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "old-route", runId: run.id, sequence: 0, at, type: "route", providerId: "provider", modelId: "model-A", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "old-context", runId: run.id, sequence: 1, at, type: "context_usage", context: { usedTokens: 490_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "current-route", runId: run.id, sequence: 2, at, type: "route", providerId: "provider", modelId: "model-B", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "current-context", runId: run.id, sequence: 3, at, type: "context_usage", context: { usedTokens: 20_000, capacityTokens: 128_000, source: "provider" } });
    database.appendEvent({ id: "repeated-route", runId: run.id, sequence: 4, at, type: "route", providerId: "provider", modelId: "model-B", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "current-usage", runId: run.id, sequence: 5, at, type: "usage", usage: { inputTokens: 21_000, outputTokens: 1_000, estimatedUsd: 0, purpose: "main" } });
    const preview = database.getSessionView("session")!.runs[0]!.events;
    expect(preview.map(event => event.id)).toEqual(["old-route", "old-context", "current-route", "current-context", "repeated-route", "current-usage"]);
    expect(latestContextUsage(preview)).toEqual(latestContextUsage(database.getSessionDetail("session")!.runs[0]!.events));
    expect(latestContextUsage(preview)).toEqual({ usedTokens: 22_000, capacityTokens: 128_000, source: "provider" });
  });

  it("does not reuse a former model's measurements when routing away and back", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "route-A", runId: run.id, sequence: 0, at, type: "route", providerId: "provider", modelId: "model-A", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "context-A", runId: run.id, sequence: 1, at, type: "context_usage", context: { usedTokens: 490_000, capacityTokens: 1_000_000, source: "provider" } });
    database.appendEvent({ id: "route-B", runId: run.id, sequence: 2, at, type: "route", providerId: "provider", modelId: "model-B", reason: "selected", estimatedUsd: 0 });
    database.appendEvent({ id: "context-B", runId: run.id, sequence: 3, at, type: "context_usage", context: { usedTokens: 20_000, capacityTokens: 128_000, source: "provider" } });
    database.appendEvent({ id: "route-A-again", runId: run.id, sequence: 4, at, type: "route", providerId: "provider", modelId: "model-A", reason: "selected", estimatedUsd: 0 });
    const preview = database.getSessionView("session")!.runs[0]!.events;
    expect(preview.map(event => event.id)).toEqual(["route-A", "context-A", "route-B", "context-B", "route-A-again"]);
    expect(latestContextUsage(preview)).toEqual(latestContextUsage(database.getSessionDetail("session")!.runs[0]!.events));
    expect(latestContextUsage(preview)).toBeUndefined();
  });

  it("keeps a successful main response behind a long tail of failed main requests", async () => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "estimate", runId: run.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 54_000, capacityTokens: 100_000, source: "estimate" } });
    database.appendEvent({ id: "main-succeeded", runId: run.id, sequence: 1, at, type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 });
    for (let n = 0; n < 40; n++) database.appendEvent({ id: `failed-${n}`, runId: run.id, sequence: n + 2, at, type: "model_request_finished", purpose: "main", succeeded: false, durationMs: 1 });
    const preview = database.getSessionView("session")!.runs[0]!.events;
    expect(preview.map(event => event.id)).toEqual(["estimate", "main-succeeded", "failed-39"]);
    expect(preview.some(event => event.type === "model_request_finished" && event.purpose === "main" && event.succeeded)).toBe(true);
  });

  it.each((["full_compaction", "tool_prune", "tool_result_bound", "runtime_control_removed"] as const)
    .flatMap(committedKind => (["resume_rebuild", "policy_migration"] as const).map(kind => ({ committedKind, kind }))))("keeps committed $committedKind behind a later $kind token estimate", async ({ committedKind, kind }) => {
    const { database, crypto } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    database.appendEvent({ id: "initial-context", runId: run.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 86_000, capacityTokens: 100_000, source: "estimate" } });
    database.appendEvent({ id: "committed-change", runId: run.id, sequence: 1, at, type: "context_adjusted", adjustment: { kind: committedKind, afterTokens: 27_000, capacityTokens: 100_000, summaryOutcome: "accepted" } });
    database.appendEvent({ id: "private-tool", runId: run.id, sequence: 2, at, type: "tool_finished", callId: "call", durationMs: 1, output: "private ".repeat(30_000) });
    for (let n = 0; n < 40; n++) database.appendEvent({ id: `character-only-${n}`, runId: run.id, sequence: n + 3, at, type: "context_adjusted", adjustment: { kind: "tool_result_bound", beforeCharacters: 10_000, afterCharacters: 8_000 } });
    database.appendEvent({ id: "later-estimate", runId: run.id, sequence: 43, at, type: "context_adjusted", adjustment: { kind, afterTokens: 1_000, capacityTokens: 100_000 } });
    database.flushEvents();
    const decrypt = vi.spyOn(crypto, "decryptJson");
    const preview = database.getSessionView("session")!.runs[0]!.events;
    expect(preview.map(event => event.id)).toEqual(["initial-context", "committed-change", "later-estimate"]);
    const committed = (event: AgentEvent) => event.type === "context_adjusted" && isCommittedContextAdjustment(event.adjustment);
    expect(preview.some(committed)).toBe(true);
    expect(decrypt.mock.calls.some(call => String(call[1]) === "event:run-001:2" || String(call[1]).startsWith("content:"))).toBe(false);
    expect(latestContextUsage(preview)).toEqual(latestContextUsage(database.getSessionDetail("session")!.runs[0]!.events));
  });

  const estimate = (usedTokens: number, capacityTokens = 100_000): AgentEventInput => ({ type: "context_usage", context: { usedTokens, capacityTokens, source: "estimate" } });
  const preservationCases: Array<{ name: string; events: AgentEventInput[]; expected: ContextUsage }> = [
    {
      name: "an estimate-only baseline before resuming",
      events: [estimate(49_000), { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 },
        { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }, estimate(1_000)],
      expected: { usedTokens: 49_000, capacityTokens: 100_000, source: "estimate" },
    },
    {
      name: "growth from a noncommitted adjustment without its own capacity",
      events: [estimate(49_000), { type: "context_adjusted", adjustment: { kind: "resume_rebuild", afterTokens: 50_000 } }, estimate(1_000)],
      expected: { usedTokens: 50_000, capacityTokens: 100_000, source: "estimate" },
    },
    {
      name: "capacity established before the latest positive main input usage",
      events: [estimate(49_000), { type: "usage", usage: { inputTokens: 40_000, outputTokens: 1_000, estimatedUsd: 0, purpose: "main" } }, estimate(1_000)],
      expected: { usedTokens: 41_000, capacityTokens: 100_000, source: "provider" },
    },
    {
      name: "a new capacity without restoring the earlier larger footprint",
      events: [estimate(86_000), estimate(55_000, 128_000), estimate(1_000, 128_000)],
      expected: { usedTokens: 55_000, capacityTokens: 128_000, source: "estimate" },
    },
    {
      name: "the provider baseline after a committed compaction and before resuming",
      events: [estimate(86_000), { type: "context_adjusted", adjustment: { kind: "full_compaction", afterTokens: 27_000, capacityTokens: 100_000 } },
        { type: "context_usage", context: { usedTokens: 29_000, capacityTokens: 100_000, source: "provider" } },
        { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 },
        { type: "context_adjusted", adjustment: { kind: "resume_rebuild", afterTokens: 1_000, capacityTokens: 100_000 } }, estimate(1_000)],
      expected: { usedTokens: 29_000, capacityTokens: 100_000, source: "provider" },
    },
  ];
  it.each(preservationCases)("preserves $name equally in previews and canonical history", async ({ events, expected }) => {
    const { database } = await fixture();
    const run = spec(1); database.saveRun(run, "running");
    events.forEach((event, sequence) => database.appendEvent({ ...event, id: `event-${sequence}`, runId: run.id, sequence, at }));
    const preview = database.getSessionView("session")!.runs[0]!.events;
    const canonical = database.getSessionDetail("session")!.runs[0]!.events;
    expect(latestContextUsage(canonical, { preserveMeasurements: true })).toEqual(expected);
    expect(latestContextUsage(preview, { preserveMeasurements: true })).toEqual(expected);
    expect(preview.length).toBeLessThanOrEqual(6);
  });

  it.each([{ previousRound: false, thirdRoute: false }, { previousRound: true, thirdRoute: false }, { previousRound: false, thirdRoute: true }, { previousRound: true, thirdRoute: true }])(
    "keeps a current run's measured occupancy across route initialization (previousRound=$previousRound, thirdRoute=$thirdRoute)", async ({ previousRound, thirdRoute }) => {
      const { database } = await fixture();
      if (previousRound) {
        const previous = spec(0); database.saveRun(previous, "completed");
        database.appendEvent({ id: "previous-context", runId: previous.id, sequence: 0, at, type: "context_usage", context: { usedTokens: 39_000, capacityTokens: 100_000, source: "provider" } });
      }
      const run = spec(1); database.saveRun(run, "running");
      database.appendEvent({ id: "route-A", runId: run.id, sequence: 0, at, type: "route", providerId: "provider", modelId: "model-A", reason: "selected", estimatedUsd: 0 });
      database.appendEvent({ id: "measured-A", runId: run.id, sequence: 1, at, type: "context_usage", context: { usedTokens: 49_000, capacityTokens: 100_000, source: "provider" } });
      database.appendEvent({ id: "route-B", runId: run.id, sequence: 2, at, type: "route", providerId: "provider", modelId: "model-B", reason: "selected", estimatedUsd: 0 });
      database.appendEvent({ id: "preparing-B", runId: run.id, sequence: 3, at, ...estimate(1_000) });
      if (thirdRoute) {
        database.appendEvent({ id: "route-C", runId: run.id, sequence: 4, at, type: "route", providerId: "provider", modelId: "model-C", reason: "selected", estimatedUsd: 0 });
        database.appendEvent({ id: "preparing-C", runId: run.id, sequence: 5, at, ...estimate(1_000) });
      }
      const preview = database.getSessionView("session")!;
      const canonical = database.getSessionDetail("session")!;
      const render = (runs: typeof canonical.runs) => renderToStaticMarkup(createElement(SessionCacheStats, {
        turns: runs.map(item => ({ runId: item.spec.id, request: item.spec.request, status: item.status, events: item.events,
          view: { lastSequence: item.events.at(-1)?.sequence ?? -1, eventsComplete: false } })),
      }));
      const previewHtml = render(preview.runs);
      const canonicalHtml = render(canonical.runs);
      expect(previewHtml).toEqual(canonicalHtml);
      expect(previewHtml.replace(/<[^>]+>/g, "")).toContain("上下文49%");
      expect(previewHtml.match(/role="meter"/g)).toHaveLength(1);
      expect(latestContextUsage(preview.runs.at(-1)!.events)).toEqual({ usedTokens: 1_000, capacityTokens: 100_000, source: "estimate" });
    },
  );

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
