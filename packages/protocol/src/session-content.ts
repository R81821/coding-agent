import type { AgentEvent, DaemonRequestInput, RunEventPage, SessionView } from "./index.js";
import { mergeViewPage } from "./session-view.js";

export function isDeferredOutput(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "deferred" in value && value.deferred === true);
}

type Update = (change: (view: SessionView) => SessionView) => void;
type Job = { key: string; priority: number; run: () => Promise<void> };

/** Bounded, cooperative hydration. RPC pages are transport details, never user actions. */
export class SessionContentLoader {
  private stopped = false;
  private running = new Set<string>();
  private failures = new Map<string, { attempts: number; after: number }>();
  private visible = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private histories = new Map<string, { through: number; cursor: number; events: AgentEvent[] }>();
  private outputs = new Map<string, { offset: number; chunks: string[] }>();
  private deferred = new WeakMap<AgentEvent[], Array<Extract<AgentEvent, { type: "tool_finished" }>>>();

  constructor(private options: {
    sessionId: string;
    request: <T>(input: DaemonRequestInput) => Promise<T>;
    read: () => SessionView | undefined;
    update: Update;
    onError: (message: string) => void;
  }) {}

  prioritize(ids: string[]) { this.visible = new Set(ids); this.wake(); }
  wake() {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 16);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.histories.clear(); this.outputs.clear(); }
  retry() { this.failures.clear(); this.wake(); }
  private view() {
    const view = this.options.read();
    return view?.session.id === this.options.sessionId ? view : undefined;
  }
  private update(change: (view: SessionView) => SessionView) {
    if (!this.stopped) this.options.update(view => view.session.id === this.options.sessionId ? change(view) : view);
  }
  private pump() {
    const view = this.view();
    if (this.stopped || !view) return;
    const jobs: Job[] = [];
    for (const run of [...view.runs].reverse()) {
      const id = run.spec.id;
      const visible = this.visible.has(id);
      if (run.view && !run.view.eventsComplete) {
        jobs.push({ key: `events:${id}`, priority: visible ? 0 : 3, run: () => this.history(id) });
      } else {
        let pending = this.deferred.get(run.events);
        if (!pending) {
          pending = run.events.filter((event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished" && isDeferredOutput(event.output));
          this.deferred.set(run.events, pending);
        }
        for (const event of pending) {
          jobs.push({ key: `output:${event.id}`, priority: visible ? 1 : 4, run: () => this.output(id, event) });
        }
      }
    }
    if (view.hasMore) jobs.push({ key: "older", priority: 2, run: async () => {
      const page = await this.options.request<SessionView | undefined>({ method: "session.view", params: { sessionId: view.session.id, limit: 20, ...(view.before ? { before: view.before } : {}) } });
      if (!page) throw new Error("会话不存在或已被删除");
      if (page.hasMore && (!page.before || JSON.stringify(page.before) === JSON.stringify(view.before))) throw new Error("历史游标未前进");
      this.update(current => mergeViewPage(current, page));
    } });
    jobs.sort((a, b) => a.priority - b.priority);
    for (const job of jobs) {
      if (this.running.size >= 2) break;
      const failure = this.failures.get(job.key);
      if (this.running.has(job.key) || (failure && (failure.attempts >= 3 || Date.now() < failure.after))) continue;
      this.running.add(job.key);
      void job.run().then(() => this.failures.delete(job.key)).catch(error => {
        if (this.stopped) return;
        const attempts = (this.failures.get(job.key)?.attempts ?? 0) + 1;
        this.failures.set(job.key, { attempts, after: Date.now() + attempts * 500 });
        if (attempts === 3) this.options.onError(`部分会话内容暂时无法读取：${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { this.running.delete(job.key); this.wake(); });
    }
    if (!this.running.size && jobs.some(job => { const failure = this.failures.get(job.key); return failure && failure.attempts < 3; })) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 500);
    }
  }
  private async history(id: string) {
    const run = this.view()?.runs.find(run => run.spec.id === id);
    if (!run?.view) return;
    const state = this.histories.get(id) ?? { through: run.view.lastSequence, cursor: -1, events: [] };
    const page = await this.options.request<RunEventPage>({ method: "run.eventPage", params: { runId: id, afterSequence: state.cursor, limit: 200 } });
    if (this.stopped) return;
    if (page.hasMore && page.nextSequence <= state.cursor) throw new Error("执行记录游标未前进");
    state.cursor = page.nextSequence;
    state.events.push(...page.events);
    this.histories.set(id, state);
    if (page.hasMore && page.nextSequence < state.through) return;
    this.update(current => ({ ...current, runs: current.runs.map(item => {
      if (item.spec.id !== id) return item;
      // Discard synthetic previews only after their entire range is canonical. Keep newer live events.
      const events = [...state.events, ...item.events.filter(event => event.sequence > page.nextSequence)];
      const ahead = (item.view?.lastSequence ?? -1) > page.nextSequence;
      return { ...item, events, status: ahead || page.hasMore ? item.status : page.status,
        view: { lastSequence: Math.max(item.view?.lastSequence ?? -1, page.nextSequence), eventsComplete: true } };
    }) }));
    this.histories.delete(id);
  }
  private async output(id: string, event: Extract<AgentEvent, { type: "tool_finished" }>) {
    const state = this.outputs.get(event.id) ?? { offset: 0, chunks: [] };
    const page = await this.options.request<{ text: string; nextOffset: number; hasMore: boolean }>({ method: "run.output", params: { runId: id, callId: event.callId, offset: state.offset, limit: 64000 } });
    if (this.stopped) return;
    if (page.hasMore && page.nextOffset <= state.offset) throw new Error("工具输出游标未前进");
    state.offset = page.nextOffset; state.chunks.push(page.text); this.outputs.set(event.id, state);
    if (page.hasMore) return;
    const text = state.chunks.join("");
    this.update(current => ({ ...current, runs: current.runs.map(run => run.spec.id !== id ? run : {
      ...run, events: run.events.map(item => item.id === event.id && item.type === "tool_finished" ? { ...item, output: text } : item),
    }) }));
    this.outputs.delete(event.id);
  }
}
