import type { ConversationTask } from "@harness/protocol";
import { graphTasksCompatible } from "./graph-task-execution.js";

export interface ConversationTaskSchedulerOptions {
  maxParallel: number;
  isolatedWrites: boolean;
  list(): ConversationTask[];
  eligible(task: ConversationTask): boolean;
  execute(task: ConversationTask): Promise<void>;
  onError(error: unknown): void;
}

/** One dispatcher per parent run. Pending input remains durable, never in a batch closure. */
export class ConversationTaskScheduler {
  private readonly active = new Map<string, { task: ConversationTask; completion: Promise<void> }>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private pumping = false;
  private revision = 0;
  private parallel: number;

  constructor(private readonly options: ConversationTaskSchedulerOptions) {
    if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 8) throw new Error("Task concurrency must be between 1 and 8");
    this.parallel = options.maxParallel;
  }

  setConcurrency(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.options.maxParallel) throw new Error("Requested concurrency exceeds the configured task limit");
    this.parallel = limit;
    this.notify();
  }

  notify(): void {
    this.revision++;
    for (const listener of [...this.listeners]) listener();
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const tasks = this.options.list();
      const depths = new Map<string, number>();
      const visiting = new Set<string>();
      const depth = (task: ConversationTask): number => {
        if (visiting.has(task.taskId)) return 0; // The persistent submit path rejects cycles.
        if (depths.has(task.taskId)) return depths.get(task.taskId)!;
        visiting.add(task.taskId);
        const result = 1 + Math.max(0, ...tasks.filter(next => next.planGeneration === task.planGeneration && next.dependsOn.includes(task.stepId) || next.dependsOn.includes(task.taskId)).map(depth));
        visiting.delete(task.taskId);
        depths.set(task.taskId, result);
        return result;
      };
      const pending = tasks.filter(task => ["queued", "blocked"].includes(task.executionState))
        .sort((a, b) => b.priority - a.priority || depth(b) - depth(a) || a.createdAt.localeCompare(b.createdAt) || (a.enqueueOrder ?? Number.MAX_SAFE_INTEGER) - (b.enqueueOrder ?? Number.MAX_SAFE_INTEGER) || a.taskId.localeCompare(b.taskId));
      for (const task of pending) {
        if (this.closed || this.active.size >= this.parallel) break;
        if (this.active.has(task.taskId)) continue;
        if (!this.options.eligible(task) || ![...this.active.values()].every(other => !task.resourceKeys.some(key => other.task.resourceKeys.includes(key)) && graphTasksCompatible(
          { id: task.taskId, prompt: task.prompt, mode: task.mode, writePaths: task.writePaths },
          { id: other.task.taskId, prompt: other.task.prompt, mode: other.task.mode, writePaths: other.task.writePaths },
          this.options.isolatedWrites,
        ))) continue;
        const completion = Promise.resolve().then(async () => {
          // Pause can arrive after selection and before this microtask starts.
          if (!this.closed && this.options.eligible(task)) await this.options.execute(task);
        }).catch(error => this.options.onError(error)).finally(() => {
          this.active.delete(task.taskId);
          this.notify();
        });
        this.active.set(task.taskId, { task, completion });
      }
    } catch (error) { this.options.onError(error); }
    finally { this.pumping = false; }
  }

  pause(): void {
    this.closed = true;
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }

  async settle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()].map(item => item.completion));
  }

  /** Event wait with a revision boundary prevents a completion between snapshot and subscribe. */
  async wait(taskIds: string[], mode: "any" | "all", signal: AbortSignal, timeoutMs = 30_000): Promise<ConversationTask[]> {
    signal.throwIfAborted();
    const selected = () => this.options.list().filter(task => !taskIds.length || taskIds.includes(task.taskId));
    const before = this.revision;
    const initial = selected();
    const initialKey = JSON.stringify(initial);
    const done = (task: ConversationTask) => !["queued", "blocked", "running"].includes(task.executionState);
    if (this.closed || initial.every(done) || mode === "any" && initial.some(done)) return initial;
    await new Promise<void>((resolveWait, rejectWait) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(changed); signal.removeEventListener("abort", abort); };
      const changed = () => {
        const current = selected();
        if (this.closed || mode === "any" && JSON.stringify(current) !== initialKey || mode === "all" && current.every(done)) { cleanup(); resolveWait(); }
      };
      const abort = () => { cleanup(); rejectWait(signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolveWait(); }, Math.max(1, Math.min(timeoutMs, 60_000)));
      this.listeners.add(changed);
      signal.addEventListener("abort", abort, { once: true });
      if (this.revision !== before) changed();
      if (signal.aborted) abort();
    });
    return selected();
  }
}
