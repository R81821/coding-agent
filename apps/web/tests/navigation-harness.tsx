// Browser regression fixture: run with the Web dev server, never with a real daemon.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PROFILE, type DaemonRequestInput, type SessionView } from "@harness/protocol";
import { useWorkbench, type Workbench } from "../src/hooks/use-workbench";

const at = "2026-10-05T00:00:00.000Z";
const reads: string[] = [];
const pending = new Map<string, Array<(value: SessionView | undefined) => void>>();
// Session ids whose next `session.view` fails instead of waiting for a resolver.
const rejects = new Set<string>();
let droppedPolls = 0;
let flakyPolls = 0;
function fixture(id: string, live = false): SessionView {
  return { session: { id, title: id, workspacePath: `D:/fixture/${id}`, profileId: "default", createdAt: at, updatedAt: at },
    runs: live ? [{ spec: { id: "run-live", sessionId: id, workspacePath: `D:/fixture/${id}`, profileId: "default", request: "fixture", budget: DEFAULT_PROFILE.budget, attachments: [], grants: [], createdAt: at }, status: "running", events: [], view: { lastSequence: 10, eventsComplete: false } }] : [], hasMore: false };
}
window.fetch = async (_url, options) => {
  const request = JSON.parse(String(options?.body)) as DaemonRequestInput;
  reads.push(request.method);
  let result: unknown;
  switch (request.method) {
    case "health": result = { status: "ok" }; break;
    case "profiles.list": result = [DEFAULT_PROFILE]; break;
    case "sessions.list": result = { items: [fixture("A").session, fixture("B").session], hasMore: false }; break;
    case "projects.list": case "skills.list": case "plugins.list": case "approvals.list": result = []; break;
    case "session.view": {
      const id = request.params.sessionId;
      if (rejects.delete(id)) throw new Error("会话读取失败（夹具）");
      result = await new Promise<SessionView | undefined>(resolve => pending.set(id, [...(pending.get(id) ?? []), resolve]));
      break;
    }
    case "run.eventPage": {
      const { afterSequence, runId } = request.params;
      if (runId === "run-flaky") {
        // One transient drop, then the run completes on a later poll: the follow loop must recover
        // by itself instead of freezing until the conversation is re-selected.
        if (droppedPolls > 0) { droppedPolls--; throw new Error("transient poll failure"); }
        check(afterSequence === 10, "Poll did not resume from the snapshot cursor");
        flakyPolls++;
        result = flakyPolls >= 2
          ? { events: [{ id: "flaky-result", runId, at, sequence: 11, type: "result", status: "completed", text: "flaky fixture" }], nextSequence: 11, hasMore: false, status: "completed" }
          : { events: [], nextSequence: 10, hasMore: false, status: "running" };
        break;
      }
      if (![10, -1].includes(afterSequence)) throw new Error("Did not resume from snapshot/history cursor");
      result = { events: afterSequence === -1 ? [{ id: "live-result", runId, at, sequence: 10, type: "result", status: "completed", text: "complete fixture" }] : [], nextSequence: 10, hasMore: false, status: "completed" };
      break;
    }
    default: throw new Error(`Unexpected request ${request.method}`);
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { "Content-Type": "application/json" } });
};
// Already hydrated, still running: only the live follow loop reads this conversation, so a dropped
// poll can be told apart from the automatic history hydration.
function flakyFixture(id: string): SessionView {
  return { session: { id, title: id, workspacePath: `D:/fixture/${id}`, profileId: "default", createdAt: at, updatedAt: at },
    runs: [{ spec: { id: "run-flaky", sessionId: id, workspacePath: `D:/fixture/${id}`, profileId: "default", request: "fixture", budget: DEFAULT_PROFILE.budget, attachments: [], grants: [], createdAt: at },
      status: "running", events: [], view: { lastSequence: 10, eventsComplete: true } }], hasMore: false };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 100; i++) { if (test()) return; await delay(10); }
  throw new Error("Timed out waiting for render/request");
}
function resolve(id: string, value = fixture(id)) { const next = pending.get(id)?.shift(); if (!next) throw new Error(`No pending ${id}`); next(value); }
function check(ok: unknown, message: string) { if (!ok) throw new Error(message); }
let current: Workbench;
function Harness() {
  current = useWorkbench();
  const [result, setResult] = useState("Ready");
  async function run() {
    setResult("Running");
    try {
      await current.connect(); await until(() => current.mode === "local" && !current.loading);
      current.setActiveId("A"); await until(() => !!pending.get("A")?.length);
      check(current.activeId === "A" && current.selectionLoading, "Selection must commit before response");
      current.setActiveId("B"); await until(() => !!pending.get("B")?.length);
      resolve("B"); await until(() => current.detail?.session.id === "B");
      resolve("A"); await delay(50);
      check(current.activeId === "B" && current.detail?.session.id === "B", "Late A replaced B");
      current.setActiveId("A"); await until(() => !!pending.get("A")?.length);
      resolve("A"); await until(() => current.detail?.session.id === "A");
      current.setActiveId("B"); await until(() => !!pending.get("B")?.length);
      check(current.detail?.session.id === "B" && current.selectionLoading, "Cached B must show while revalidating");
      // A background run finishing in A must not invalidate the pending B read.
      const reload = current.reloadDetail("A"); await until(() => !!pending.get("A")?.length);
      resolve("A"); await reload;
      resolve("B"); await until(() => !current.selectionLoading);
      check(current.detail?.session.id === "B", "Inactive reload overwrote B");
      const idleReads = reads.length; await delay(1900);
      check(reads.length === idleReads, "Completed conversation is still polling");
      current.setActiveId("A"); await until(() => !!pending.get("A")?.length);
      current.setActiveId("B"); await until(() => !!pending.get("B")?.length);
      pending.get("A")!.shift()!(undefined);
      resolve("B"); await until(() => !current.selectionLoading);
      check(!current.error && current.detail?.session.id === "B", "Late missing-session error replaced B");
      current.setActiveId("missing"); await until(() => !!pending.get("missing")?.length);
      pending.get("missing")!.shift()!(undefined);
      await until(() => !current.selectionLoading);
      check(!current.detail && !!current.error, "Unavailable session did not clear its preview");
      current.setActiveId("missing"); await until(() => !!pending.get("missing")?.length);
      resolve("missing"); await until(() => !current.selectionLoading);
      check(current.detail?.session.id === "missing" && !current.error, "Retry after a failed read did not recover");
      current.setActiveId("live"); await until(() => !!pending.get("live")?.length);
      resolve("live", fixture("live", true));
      await until(() => current.detail?.runs.at(-1)?.status === "completed");
      await until(() => current.detail?.runs.at(-1)?.view?.eventsComplete === true);
      const completedReads = reads.length; await delay(1900);
      check(reads.length === completedReads, "Finished live subscription is still polling");
      check(!reads.includes("session.get"), "Full transcript requested");
      // A failed revalidation must release the selection instead of leaving it loading forever.
      current.setActiveId("A"); await until(() => !!pending.get("A")?.length);
      rejects.add("A");
      await current.reloadDetail("A").catch(() => {});
      await delay(50);
      check(!current.selectionLoading, "Failed revalidation left the selection stuck loading");
      resolve("A"); await delay(50);
      check(current.detail?.session.id === "A", "Superseded read replaced the selection");
      // A dropped live poll must recover on its own: the run finishes without re-selecting.
      current.setActiveId("flaky"); await until(() => !!pending.get("flaky")?.length);
      droppedPolls++;
      resolve("flaky", flakyFixture("flaky"));
      await delay(200);
      check(!!current.error, "Dropped poll did not surface an error");
      await delay(3000);
      check(current.detail?.runs.at(-1)?.status === "completed" && droppedPolls === 0 && flakyPolls >= 2, "Dropped poll did not recover on its own");
      current.disconnect(); await until(() => current.mode === "demo");
      check(!current.detail && !current.activeId, "Disconnect retained decrypted conversation");
      setResult("PASS: immediate selection; latest navigation wins; LRU preview; inactive reload isolation; stale error isolation; unavailable-session retry; idle polling stops; cursor-based live completion; failed revalidation releases the selection; dropped poll recovers; disconnect clears view");
    } catch (e) { setResult(`FAIL: ${String(e)}`); }
  }
  return <main><h1>Conversation navigation regression</h1><button onClick={() => void run()} disabled={result === "Running"}>Run regression</button><p role="status">{result}</p><p>Selected: {current.activeId ?? "none"}; view: {current.detail?.session.id ?? "none"}; loading: {String(current.selectionLoading)}</p></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
