import { describe, expect, it, vi } from "vitest";
import { ConversationTaskSchema, type ConversationTask } from "@harness/protocol";
import { ConversationTaskScheduler } from "../packages/core/src/conversation-task-scheduler.js";

const at = "2026-10-15T00:00:00.000Z";
const task = (taskId: string, overrides: Record<string, unknown> = {}): ConversationTask => ConversationTaskSchema.parse({
  taskId, sessionId: "session", parentRunId: "parent", stepId: taskId, planGeneration: 1,
  source: { kind: "run" }, mode: "read", prompt: `Execute ${taskId}`, createdAt: at, updatedAt: at, ...overrides,
});
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const nextMicrotasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(initial: ConversationTask[], options: { maxParallel?: number; isolatedWrites?: boolean; eligible?: (task: ConversationTask) => boolean } = {}) {
  const rows = new Map(initial.map(row => [row.taskId, row]));
  const releases = new Map<string, ReturnType<typeof gate<void>>>();
  const starts: string[] = [];
  const finished: string[] = [];
  const errors = vi.fn();
  let active = 0, peak = 0;
  const update = (id: string, patch: Partial<ConversationTask>) => rows.set(id, { ...rows.get(id)!, ...patch, queueVersion: (rows.get(id)?.queueVersion ?? 0) + 1 });
  const scheduler = new ConversationTaskScheduler({
    maxParallel: options.maxParallel ?? 2, isolatedWrites: options.isolatedWrites ?? false,
    list: () => [...rows.values()], eligible: row => ["queued", "blocked"].includes(rows.get(row.taskId)!.executionState) && (options.eligible?.(row) ?? true),
    execute: async row => {
      starts.push(row.taskId); active++; peak = Math.max(active, peak);
      update(row.taskId, { executionState: "running" });
      const release = gate(); releases.set(row.taskId, release);
      try { await release.promise; update(row.taskId, { executionState: "awaiting_integration" }); }
      catch (error) { update(row.taskId, { executionState: "failed", error: String(error) }); throw error; }
      finally { active--; finished.push(row.taskId); }
    }, onError: errors,
  });
  return { rows, releases, starts, finished, errors, update, scheduler, get peak() { return peak; } };
}

describe("persistent conversation task dispatcher", () => {
  it("fills a released slot with a newly submitted batch while an earlier task remains gated", async () => {
    const verified = new Set<string>();
    const f = fixture([task("A"), task("B")], { eligible: row => row.dependsOn.every(id => verified.has(id)) });
    f.scheduler.notify(); await nextMicrotasks();
    expect(f.starts).toEqual(["A", "B"]);
    f.releases.get("B")!.resolve(); await nextMicrotasks();
    f.rows.set("C", task("C"));
    f.rows.set("D", task("D", { executionState: "blocked", dependsOn: ["A"], blockedReason: "Waiting for real verification" }));
    f.scheduler.notify(); await nextMicrotasks();
    expect(f.starts).toEqual(["A", "B", "C"]);
    expect(f.rows.get("A")!.executionState).toBe("running");
    expect(f.rows.get("D")!.executionState).toBe("blocked");
    f.releases.get("A")!.resolve(); await nextMicrotasks();
    expect(f.starts).not.toContain("D"); // Execution completion is not a verification receipt.
    verified.add("A"); f.scheduler.notify(); await nextMicrotasks();
    expect(f.starts).toEqual(["A", "B", "C", "D"]);
    f.releases.get("C")!.resolve(); f.releases.get("D")!.resolve(); await f.scheduler.settle();
    expect(f.peak).toBe(2);
  });

  it("uses priority and stable creation order when the next slot becomes available", async () => {
    const f = fixture([task("low", { priority: 1 }), task("high-later", { priority: 90, createdAt: "2026-10-15T00:00:01.000Z" }), task("high-first", { priority: 90 })], { maxParallel: 1 });
    f.scheduler.notify(); await nextMicrotasks(); expect(f.starts).toEqual(["high-first"]);
    f.releases.get("high-first")!.resolve(); await nextMicrotasks(); expect(f.starts).toEqual(["high-first", "high-later"]);
    f.releases.get("high-later")!.resolve(); await nextMicrotasks(); expect(f.starts).toEqual(["high-first", "high-later", "low"]);
    f.releases.get("low")!.resolve(); await f.scheduler.settle();
  });

  it("does not select an already reserved task again before its execute microtask", async () => {
    const f = fixture([task("only")], { maxParallel: 4 });
    f.scheduler.notify(); f.scheduler.notify(); f.scheduler.notify();
    await nextMicrotasks(); expect(f.starts).toEqual(["only"]);
    f.releases.get("only")!.resolve(); await f.scheduler.settle();
  });

  it("prefers the critical path at equal priority and retains durable enqueue order for a tie", async () => {
    const f = fixture([task("z-first", { enqueueOrder: 1 }), task("a-later", { enqueueOrder: 2 }), task("critical", { enqueueOrder: 3 }), task("dependent", { dependsOn: ["critical"], executionState: "blocked" })], { maxParallel: 1, eligible: row => row.taskId !== "dependent" });
    f.scheduler.notify(); await nextMicrotasks(); expect(f.starts).toEqual(["critical"]);
    f.releases.get("critical")!.resolve(); await nextMicrotasks(); expect(f.starts).toEqual(["critical", "z-first"]);
    f.releases.get("z-first")!.resolve(); await nextMicrotasks(); expect(f.starts).toEqual(["critical", "z-first", "a-later"]);
    f.releases.get("a-later")!.resolve(); await f.scheduler.settle();
  });

  it.each([
    { name: "shared workspace write and read", isolated: false, left: { mode: "write", writePaths: ["src/a.ts"] }, right: { mode: "read" }, expected: 1 },
    { name: "Windows case and directory overlap", isolated: true, left: { mode: "write", writePaths: ["SRC\\Widgets"] }, right: { mode: "write", writePaths: ["src/widgets/view.ts"] }, expected: 1 },
    { name: "unknown isolated write scope", isolated: true, left: { mode: "write" }, right: { mode: "write", writePaths: ["docs/a.md"] }, expected: 1 },
    { name: "disjoint isolated writes", isolated: true, left: { mode: "write", writePaths: ["src/a.ts"] }, right: { mode: "write", writePaths: ["docs/a.md"] }, expected: 2 },
    { name: "isolated write and parent read", isolated: true, left: { mode: "write", writePaths: ["src/a.ts"] }, right: { mode: "read" }, expected: 2 },
  ])("enforces actual overlap for $name", async ({ isolated, left, right, expected }) => {
    const f = fixture([task("a", left), task("b", right)], { isolatedWrites: isolated });
    f.scheduler.notify(); await nextMicrotasks(); expect(f.starts).toHaveLength(expected);
    f.releases.get("a")!.resolve(); await nextMicrotasks();
    expect(f.starts).toEqual(["a", "b"]); f.releases.get("b")!.resolve(); await f.scheduler.settle();
    expect(f.peak).toBe(expected);
  });

  it("keeps unrelated work moving when one child fails", async () => {
    const f = fixture([task("a"), task("b"), task("c")]);
    f.scheduler.notify(); await nextMicrotasks();
    f.releases.get("b")!.reject(new Error("fixture failure")); await nextMicrotasks();
    expect(f.starts).toEqual(["a", "b", "c"]);
    expect(f.rows.get("b")!.executionState).toBe("failed");
    expect(f.rows.get("a")!.executionState).toBe("running");
    expect(f.errors).toHaveBeenCalledOnce();
    f.releases.get("a")!.resolve(); f.releases.get("c")!.resolve(); await f.scheduler.settle();
  });

  it("serializes shared resource keys even when both task bodies only read", async () => {
    const f = fixture([task("browser-a", { resourceKeys: ["browser:session"] }), task("browser-b", { resourceKeys: ["browser:session"] }), task("independent", { resourceKeys: ["files:docs"] })]);
    f.scheduler.notify(); await nextMicrotasks(); expect(f.starts).toEqual(["browser-a", "independent"]);
    f.releases.get("browser-a")!.resolve(); await nextMicrotasks(); expect(f.starts).toEqual(["browser-a", "independent", "browser-b"]);
    f.releases.get("browser-b")!.resolve(); f.releases.get("independent")!.resolve(); await f.scheduler.settle();
    expect(f.peak).toBe(2);
  });

  it("closes dispatch before the selected microtask starts", async () => {
    const f = fixture([task("a"), task("b")]);
    f.scheduler.notify(); f.scheduler.pause(); await f.scheduler.settle();
    expect(f.starts).toEqual([]);
    expect([...f.rows.values()].map(row => row.executionState)).toEqual(["queued", "queued"]);
  });

  it("rechecks parent eligibility between selection and child startup", async () => {
    let pausing = false;
    const f = fixture([task("a")], { eligible: () => !pausing });
    f.scheduler.notify(); pausing = true; await f.scheduler.settle();
    expect(f.starts).toEqual([]);
  });

  it("does not refill after pause and wakes a waiter before active work finishes cleanup", async () => {
    const f = fixture([task("a"), task("b"), task("c")]);
    f.scheduler.notify(); await nextMicrotasks();
    const waiting = f.scheduler.wait([], "all", new AbortController().signal);
    f.scheduler.pause(); const snapshot = await waiting;
    expect(snapshot.filter(row => row.executionState === "running")).toHaveLength(2);
    f.releases.get("a")!.resolve(); f.releases.get("b")!.resolve(); await f.scheduler.settle();
    expect(f.starts).toEqual(["a", "b"]); expect(f.rows.get("c")!.executionState).toBe("queued");
  });

  it("waits for the selected set instead of an unrelated task notification", async () => {
    const f = fixture([task("a"), task("b")]);
    f.scheduler.notify(); await nextMicrotasks();
    const resolved = vi.fn();
    const waiting = f.scheduler.wait(["a"], "any", new AbortController().signal).then(value => { resolved(); return value; });
    f.releases.get("b")!.resolve(); await nextMicrotasks(); expect(resolved).not.toHaveBeenCalled();
    f.releases.get("a")!.resolve(); expect((await waiting).map(row => row.executionState)).toEqual(["awaiting_integration"]);
    await f.scheduler.settle();
  });

  it("does not lose a state change between taking the initial snapshot and subscribing", async () => {
    let row = task("a", { executionState: "running" });
    let notifyDuringRead = true;
    const scheduler = new ConversationTaskScheduler({
      maxParallel: 1, isolatedWrites: false, eligible: () => false, execute: async () => {}, onError: vi.fn(),
      list: () => {
        const snapshot = [row];
        if (notifyDuringRead) { notifyDuringRead = false; row = { ...row, executionState: "awaiting_integration", queueVersion: 1 }; scheduler.notify(); }
        return snapshot;
      },
    });
    const waiting = scheduler.wait(["a"], "all", new AbortController().signal, 60_000);
    expect((await waiting)[0]!.executionState).toBe("awaiting_integration");
  });

  it("cleans up an aborted wait without stopping its running children", async () => {
    const f = fixture([task("a")]);
    f.scheduler.notify(); await nextMicrotasks(); const controller = new AbortController();
    const wait = f.scheduler.wait(["a"], "all", controller.signal);
    controller.abort(new Error("caller left")); await expect(wait).rejects.toThrow("caller left");
    expect(f.rows.get("a")!.executionState).toBe("running");
    f.releases.get("a")!.resolve(); await f.scheduler.settle();
  });
});
