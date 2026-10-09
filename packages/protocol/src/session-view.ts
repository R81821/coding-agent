import type { RunEventPage, SessionDetail, SessionView } from "./index.js";

// Immutable runs share their measured size. Avoid serializing/UTF-8 copying the whole transcript on navigation.
const measuredBytes = new WeakMap<object, number>();
function memorySize(value: unknown): number {
  if (typeof value === "string") return 2 * value.length + 16;
  if (!value || typeof value !== "object") return 8;
  const cached = measuredBytes.get(value);
  if (cached !== undefined) return cached;
  let bytes = 32;
  for (const [key, item] of Object.entries(value)) bytes += 2 * key.length + 16 + memorySize(item);
  measuredBytes.set(value, bytes);
  return bytes;
}

/** In-memory only. Entries are bounded by both count and serialized size. */
export class SessionViewCache {
  private entries = new Map<string, { value: SessionView; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries = 6, private maxBytes = 12_000_000) {}
  get(id: string): SessionView | undefined {
    const item = this.entries.get(id);
    if (!item) return;
    this.entries.delete(id); this.entries.set(id, item);
    return item.value;
  }
  set(value: SessionView): void {
    this.delete(value.session.id);
    const bytes = memorySize(value);
    if (bytes > this.maxBytes || value.session.deletedAt) return;
    this.entries.set(value.session.id, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
  }
  delete(id: string): void { this.bytes -= this.entries.get(id)?.bytes ?? 0; this.entries.delete(id); }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}

export function mergeViewPage(current: SessionView, older: SessionView): SessionView {
  if (current.session.id !== older.session.id) return current;
  const runs = new Map(older.runs.map(run => [run.spec.id, run]));
  for (const run of current.runs) runs.set(run.spec.id, run);
  return { ...older, session: current.session, runs: [...runs.values()].sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt) || a.spec.id.localeCompare(b.spec.id)) };
}

/** Keep already loaded older turns and canonical event pages when revalidating a cached view. */
export function refreshSessionView(current: SessionView | undefined, latest: SessionView): SessionView {
  if (!current || current.session.id !== latest.session.id) return latest;
  const runs = new Map((latest.hasMore ? current.runs : []).map(run => [run.spec.id, run]));
  for (const run of latest.runs) {
    const previous = current.runs.find(item => item.spec.id === run.spec.id);
    runs.set(run.spec.id, previous?.view?.eventsComplete && previous.view.lastSequence === run.view?.lastSequence
      ? { ...run, events: previous.events, view: previous.view } : run);
  }
  const keepCursor = latest.hasMore && current.runs[0] && latest.runs[0] &&
    (current.runs[0].spec.createdAt < latest.runs[0].spec.createdAt || (current.runs[0].spec.createdAt === latest.runs[0].spec.createdAt && current.runs[0].spec.id < latest.runs[0].spec.id));
  return { ...latest, ...(keepCursor ? { hasMore: current.hasMore, ...(current.before ? { before: current.before } : {}) } : {}),
    runs: [...runs.values()].sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt) || a.spec.id.localeCompare(b.spec.id)) };
}

export function mergeViewEvents<T extends SessionDetail>(view: T, runId: string, page: RunEventPage): T {
  const target = view.runs.find(run => run.spec.id === runId);
  if (!target || (!page.events.length && (page.hasMore || target.status === page.status) && (target.view?.lastSequence ?? -1) >= page.nextSequence)) return view;
  return { ...view, runs: view.runs.map(run => {
    if (run.spec.id !== runId) return run;
    const events = new Map(run.events.map(event => [event.sequence, event]));
    for (const event of page.events) {
      const old = events.get(event.sequence);
      const deferred = event.type === "tool_finished" && event.output && typeof event.output === "object" && "deferred" in event.output && event.output.deferred === true;
      const hydrated = old?.type === "tool_finished" && !(old.output && typeof old.output === "object" && "deferred" in old.output && old.output.deferred === true);
      events.set(event.sequence, deferred && hydrated ? { ...event, output: old.output } as typeof event : event);
    }
    return { ...run, status: page.hasMore ? run.status : page.status, events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
      view: { lastSequence: Math.max(run.view?.lastSequence ?? -1, page.nextSequence), eventsComplete: run.view?.eventsComplete ?? true } };
  }) };
}

