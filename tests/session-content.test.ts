import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, SessionContentLoader, mergeViewEvents, type AgentEvent, type DaemonRequestInput, type RunEventPage, type SessionView } from "@harness/protocol";
import { appliedToolChanges } from "../apps/desktop/src/code-changes.js";

const at = "2026-10-07T00:00:00.000Z";
const makeRun = (id: string, sequence = 1): SessionView["runs"][number] => ({
  spec: { id, sessionId: "session", request: id, workspacePath: "D:/fixture", profileId: "default", budget: DEFAULT_PROFILE.budget, attachments: [], grants: [], createdAt: at },
  status: "completed", events: [], view: { lastSequence: sequence, eventsComplete: false },
});
const makeView = (ids: string[], hasMore = false): SessionView => ({
  session: { id: "session", title: "fixture", workspacePath: "D:/fixture", profileId: "default", createdAt: at, updatedAt: at },
  runs: ids.map(id => makeRun(id)), hasMore, before: { createdAt: at, id: ids[0] ?? "" },
});
const result = (id: string, sequence = 1): AgentEvent => ({ id: `${id}-answer`, runId: id, sequence, at, type: "result", status: "completed", text: "完整回答".repeat(5000) });
const tool = (id: string): AgentEvent => ({ id: `${id}-tool`, runId: id, sequence: 0, at, type: "tool_finished", callId: "call", durationMs: 1, output: { deferred: true } });
const loaders: SessionContentLoader[] = [];
afterEach(() => { loaders.splice(0).forEach(loader => loader.stop()); vi.useRealTimers(); });
async function drain(count = 20) { for (let i = 0; i < count; i++) await vi.advanceTimersByTimeAsync(20); }
function setup(initial: SessionView, handler: (input: DaemonRequestInput) => Promise<unknown>) {
  vi.useFakeTimers();
  let view = initial;
  const request = vi.fn(handler);
  const onError = vi.fn();
  const loader = new SessionContentLoader({ sessionId: view.session.id, request: async <T>(input: DaemonRequestInput) => await request(input) as T,
    read: () => view, update: change => { view = change(view); }, onError });
  loaders.push(loader);
  return { loader, request, onError, read: () => view, write: (next: SessionView) => { view = next; } };
}

describe("automatic conversation hydration", () => {
  it("restores confirmed file changes only after every JSON receipt page has loaded", async () => {
    const started: Extract<AgentEvent, { type: "tool_started" }> = { id: "write-start", runId: "a", sequence: 0, at, type: "tool_started", call: { id: "write", name: "write_file", input: { path: "server/marketData.ts", content: "do not infer actual writes from this input" } } };
    const receipt = { written: true, path: "server/marketData.ts", byteLength: 25, created: true, changed: true, diff: '--- /dev/null\n+++ b/server/marketData.ts\n@@ -0,0 +1 @@\n+export const 价格 = 1;\n', added: 1, deleted: 0, diffTruncated: false };
    const saved: Extract<AgentEvent, { type: "tool_finished" }> = { id: "write-finish", runId: "a", sequence: 1, at, type: "tool_finished", callId: "write", durationMs: 1, isError: false, output: { deferred: true, runId: "a", callId: "write" } };
    const text = JSON.stringify(receipt, null, 2);
    let pages = 0;
    const work = setup(makeView(["a"]), async input => {
      if (input.method === "run.eventPage") return { events: [started, saved], nextSequence: 1, hasMore: false, status: "completed" };
      if (input.method === "run.output") {
        const pending = work.read().runs[0]!.events.find(event => event.type === "tool_finished") as typeof saved;
        expect(appliedToolChanges(started, pending)).toBeUndefined();
        pages++;
        const offset = input.params.offset;
        const nextOffset = Math.min(offset + 80, text.length);
        return { text: text.slice(offset, nextOffset), nextOffset, hasMore: nextOffset < text.length };
      }
      throw Error(input.method);
    });
    work.loader.prioritize(["a"]);
    await drain(30);
    expect(pages).toBeGreaterThan(1);
    const hydrated = work.read().runs[0]!.events[1] as typeof saved;
    expect(hydrated.output).toBe(text);
    expect(appliedToolChanges(started, hydrated)).toEqual(appliedToolChanges(started, { ...saved, output: receipt }));
    expect(appliedToolChanges(started, hydrated)?.files[0]).toMatchObject({ path: "server/marketData.ts", added: 1, deleted: 0 });
    expect(work.onError).not.toHaveBeenCalled();
  });

  it("prioritizes visible rows, preloads every older row and drains full output without user clicks", async () => {
    const output = "工具输出".repeat(40000);
    const work = setup(makeView(["a", "b"], true), async input => {
      if (input.method === "session.view") return makeView(["0"]);
      if (input.method === "run.eventPage") return { events: [tool(input.params.runId), result(input.params.runId)], nextSequence: 1, hasMore: false, status: "completed" };
      if (input.method === "run.output") {
        const { offset, limit } = input.params;
        return { text: output.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, output.length), hasMore: offset + limit < output.length };
      }
      throw Error(input.method);
    });
    work.loader.prioritize(["a"]);
    await drain(30);
    expect(work.request.mock.calls[0]![0]).toMatchObject({ method: "run.eventPage", params: { runId: "a" } });
    expect(work.read().hasMore).toBe(false);
    expect(work.read().runs.map(run => run.spec.id)).toEqual(["0", "a", "b"]);
    for (const run of work.read().runs) {
      expect(run.view?.eventsComplete).toBe(true);
      expect(run.events[0]).toMatchObject({ output });
      expect(run.events[1]).toMatchObject({ text: "完整回答".repeat(5000) });
    }
    const calls = work.request.mock.calls.length;
    work.loader.wake(); await drain();
    expect(work.request).toHaveBeenCalledTimes(calls);
    expect(work.onError).not.toHaveBeenCalled();
  });

  it("limits in-flight requests and ignores results after leaving the session", async () => {
    const pending: Array<(page: RunEventPage) => void> = [];
    const work = setup(makeView(["a", "b", "c"]), async () => new Promise<RunEventPage>(resolve => pending.push(resolve)));
    work.loader.wake(); await drain(3);
    expect(work.request).toHaveBeenCalledTimes(2);
    work.loader.stop();
    work.write({ ...makeView([]), session: { ...makeView([]).session, id: "other" } });
    pending.forEach(resolve => resolve({ events: [result("a")], nextSequence: 1, hasMore: false, status: "completed" }));
    await drain();
    expect(work.read().session.id).toBe("other");
    expect(work.read().runs).toHaveLength(0);
    expect(work.request).toHaveBeenCalledTimes(2);
  });

  it("replaces aggregated previews once, retaining newer live events and their status", async () => {
    const initial = makeView(["a"]);
    initial.runs[0]!.view!.lastSequence = 2;
    initial.runs[0]!.events = [{ id: "preview", runId: "a", sequence: 2, at, type: "text_delta", delta: "AB" }];
    const work = setup(initial, async input => {
      if (input.method !== "run.eventPage") throw Error(input.method);
      const after = input.params.afterSequence;
      const sequence = after < 0 ? 0 : 2;
      return { events: [{ id: `a-${sequence}`, runId: "a", at, sequence, type: "text_delta", delta: sequence ? "B" : "A" }], nextSequence: sequence, hasMore: sequence === 0, status: "completed" };
    });
    work.loader.wake(); await vi.advanceTimersByTimeAsync(16);
    const live: RunEventPage = { events: [{ id: "a-3", runId: "a", at, sequence: 3, type: "text_delta", delta: "C" }], nextSequence: 3, hasMore: false, status: "running" };
    work.write(mergeViewEvents(work.read(), "a", live));
    await drain();
    expect(work.read().runs[0]?.events.map(event => event.type === "text_delta" ? event.delta : "")).toEqual(["A", "B", "C"]);
    expect(work.read().runs[0]).toMatchObject({ status: "running", view: { eventsComplete: true, lastSequence: 3 } });
  });

  it("backs off, exposes a recoverable error and resumes from the last successful cursor", async () => {
    let failing = true;
    const work = setup(makeView(["a"]), async input => {
      if (input.method !== "run.eventPage") throw Error(input.method);
      if (input.params.afterSequence === -1) return { events: [{ ...result("a", 0), id: "first" }], nextSequence: 0, hasMore: true, status: "completed" };
      if (failing) throw Error("temporary failure");
      return { events: [result("a")], nextSequence: 1, hasMore: false, status: "completed" };
    });
    work.loader.wake(); await drain(150);
    expect(work.request).toHaveBeenCalledTimes(4);
    expect(work.onError).toHaveBeenCalledOnce();
    failing = false; work.loader.retry(); await drain();
    expect(work.read().runs[0]?.view?.eventsComplete).toBe(true);
    expect(work.request).toHaveBeenCalledTimes(5);
    expect(work.request.mock.calls.at(-1)![0]).toMatchObject({ params: { afterSequence: 0 } });
  });
});
