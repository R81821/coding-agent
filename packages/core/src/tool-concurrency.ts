import type { ToolDefinition } from "@harness/tools";
import type { ModelProvider } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";

export interface ExecutionConcurrency {
  tools?: number;
  modelRequests?: number;
  tasks?: number;
  queueLength?: number;
}

export function concurrencyLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024) throw new Error(`${name} must be an integer between 1 and 1024`);
  return value;
}

/** A runtime implementation opt-in is required; model-provided tool contracts are insufficient. */
export function isParallelRead(tool: ToolDefinition, input?: Record<string, unknown>): boolean {
  return !tool.external && tool.parallelReadScope !== undefined && tool.contract.risk === "read" &&
    tool.contract.idempotent && (input === undefined || (tool.assessRisk?.(input) ?? tool.contract.risk) === "read");
}

/** One owner commits workflow, cache and checkpoint mutations, even when I/O overlaps. */
export class SerialCommitQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(commit: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(commit);
    this.tail = result.catch(() => {});
    return result;
  }
  async idle(): Promise<void> { await this.tail; }
}

interface PendingExecution {
  shared: boolean;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  abort(): void;
}

/** FIFO read/exclusive gate. An exclusive item cannot be bypassed by later reads. */
export class BoundedExecutionPool {
  private active = 0;
  private exclusive = false;
  private readonly pending: PendingExecution[] = [];
  constructor(readonly limit: number) { concurrencyLimit(limit, 1, "execution concurrency"); }

  acquire(signal: AbortSignal, shared = true): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
    return new Promise((resolve, reject) => {
      const entry: PendingExecution = { shared, signal, resolve, reject, abort: () => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(signal.reason ?? new Error("Operation aborted"));
        this.drain();
      } };
      this.pending.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      this.drain();
    });
  }

  async run<T>(signal: AbortSignal, shared: boolean, execute: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire(signal, shared);
    try { signal.throwIfAborted(); return await execute(); }
    finally { release(); }
  }

  private drain(): void {
    while (this.pending.length && !this.exclusive && this.active < this.limit) {
      const next = this.pending[0]!;
      if (!next.shared && this.active > 0) return;
      this.pending.shift();
      next.signal.removeEventListener("abort", next.abort);
      this.active++;
      this.exclusive = !next.shared;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (!next.shared) this.exclusive = false;
        this.drain();
      });
    }
  }
}

/** Wrap every provider routed by an engine with the same request budget. */
export function boundModelProvider(provider: ModelProvider, pool: BoundedExecutionPool, beforeDispatch?: (request: ModelRequest) => void): ModelProvider {
  return {
    id: provider.id,
    ...(provider.promptBackend ? { promptBackend: provider.promptBackend } : {}),
    listModels: () => provider.listModels(),
    health: signal => provider.health(signal),
    estimateCost: (model, input, output) => provider.estimateCost(model, input, output),
    ...(provider.supportsNonThinkingCompaction ? { supportsNonThinkingCompaction: () => provider.supportsNonThinkingCompaction!() } : {}),
    async *stream(request, signal) {
      const release = await pool.acquire(signal);
      try { signal.throwIfAborted(); beforeDispatch?.(request); yield* provider.stream(request, signal); }
      finally { release(); }
    },
  };
}
