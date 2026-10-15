import { createHash, randomUUID } from "node:crypto";
import {
  ConversationTaskSchema, ConversationTaskUsageSchema, ConversationTaskBudgetSchema,
  type AgentEvent, type ConversationTask, type ConversationTaskInput, type ConversationTaskExecutionState,
  type ConversationTaskUsage, type ConversationTaskBudget, type RunCheckpoint,
} from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";
import type { SQLiteFile } from "./sqlite.js";

export interface ConversationTaskCommit { checkpoint?: RunCheckpoint; events?: AgentEvent[] }
export interface ConversationTaskClaimOptions extends ConversationTaskCommit {
  expectedPlanGeneration?: number; attemptId?: string; childRunId?: string;
  budgetReservation?: ConversationTaskBudget; budgetLimit?: ConversationTaskBudget; accountedUsage?: ConversationTaskUsage;
}
export interface ConversationTaskUpdateOptions extends ConversationTaskCommit { expectedAttemptId?: string; expectedPlanGeneration?: number }
export interface ConversationTaskAccountOptions extends ConversationTaskCommit { applyUsageToCheckpoint?: boolean }
export interface ConversationTaskAccountResult { task: ConversationTask; delta: ConversationTaskUsage; checkpoint?: RunCheckpoint }
export type ConversationTaskPatch = Partial<Pick<ConversationTask,
  "executionState" | "blockedReason" | "acceptanceState" | "verificationIds" | "summary" | "error" | "patch" | "workspacePath" |
  "baselineTree" | "integrationReceipt" | "retryReason" | "startedAt" | "finishedAt" | "priority" | "planGeneration" | "workspaceVersion"
>> & { accountedUsage?: Partial<ConversationTaskUsage> };
const transitions: Record<ConversationTaskExecutionState, ReadonlySet<ConversationTaskExecutionState>> = {
  blocked: new Set(["queued", "cancelled"]), queued: new Set(["blocked", "running", "cancelled"]),
  running: new Set(["awaiting_integration", "completed", "failed", "interrupted", "cancelled"]),
  awaiting_integration: new Set(["completed", "failed", "interrupted", "cancelled"]),
  completed: new Set(), failed: new Set(["queued", "cancelled"]), interrupted: new Set(["queued", "cancelled"]), cancelled: new Set(),
};
const finalStates = new Set<ConversationTaskExecutionState>(["completed", "failed", "interrupted", "cancelled"]);

/** Owned by the daemon's database, never opened by a child worker. */
export class ConversationTaskStore {
  constructor(private readonly db: SQLiteFile, private readonly crypto: VaultCrypto,
    private readonly assertParent: (parentRunId: string, sessionId?: string) => void,
    private readonly flush: () => void, private readonly commitRelated: (commit: ConversationTaskCommit, parentRunId: string) => void) {}

  version(parentRunId: string): number { return Number(this.db.prepare("SELECT version FROM conversation_task_queues WHERE parent_run_id=?").get(parentRunId)?.version ?? 0); }
  get(taskId: string, includeWithdrawn = false): ConversationTask | undefined {
    const row = this.db.prepare(`SELECT payload FROM conversation_tasks WHERE id=? ${includeWithdrawn ? "" : "AND withdrawn_at IS NULL"}`).get(taskId);
    return row ? ConversationTaskSchema.parse(this.crypto.decryptJson(row.payload as string, `conversation_task:${taskId}`)) : undefined;
  }
  list(parentRunId: string, includeWithdrawn = false): ConversationTask[] {
    return this.db.prepare(`SELECT id FROM conversation_tasks WHERE parent_run_id=? ${includeWithdrawn ? "" : "AND withdrawn_at IS NULL"} ORDER BY priority DESC,created_at,id`)
      .all(parentRunId).map(row => this.get(String(row.id), includeWithdrawn)!);
  }
  enqueue(inputs: ConversationTaskInput[], options: ConversationTaskCommit & { maxQueueLength?: number } = {}): ConversationTask[] {
    if (!inputs.length) return [];
    const tasks = inputs.map(input => ConversationTaskSchema.parse(input));
    const parent = tasks[0]!.parentRunId;
    if (tasks.some(task => task.parentRunId !== parent)) throw new Error("A queue commit must belong to one parent run");
    const max = options.maxQueueLength ?? 256;
    if (!Number.isInteger(max) || max < 1 || max > 10000) throw new Error("Invalid conversation task queue limit");
    return this.transaction(parent, options, () => {
      const existing = this.list(parent), accepted: ConversationTask[] = [], identities = new Map<string, string>();
      const known = new Map(existing.map(task => [this.key(task), task]));
      for (const task of tasks) {
        const previousKey = identities.get(task.taskId);
        if (previousKey !== undefined && previousKey !== this.key(task)) throw new Error("Conflicting conversation task identity in batch");
        identities.set(task.taskId, this.key(task));
        this.assertParent(parent, task.sessionId);
        if (task.executionState !== "queued" && task.executionState !== "blocked") throw new Error("New tasks must be queued or blocked");
        if (task.attempts.length || task.attemptId || task.childRunId || task.startedAt) throw new Error("New tasks cannot contain execution attempts");
        if (task.source.kind === "steering" && !task.source.messageId) throw new Error("A steering task requires its source message ID");
        const duplicate = known.get(this.key(task));
        if (duplicate) {
          if (duplicate.prompt !== task.prompt || duplicate.mode !== task.mode || JSON.stringify(duplicate.writePaths) !== JSON.stringify(task.writePaths) || JSON.stringify(duplicate.dependsOn) !== JSON.stringify(task.dependsOn)) throw new Error("Conflicting duplicate conversation task submission");
          accepted.push(duplicate); continue;
        }
        if (this.get(task.taskId, true)) throw new Error("Conversation task identity already exists");
        known.set(this.key(task), task); existing.push(task); accepted.push(task);
      }
      if (existing.filter(task => !finalStates.has(task.executionState)).length > max) throw new Error(`Conversation task queue limit exceeded (${max})`);
      this.assertAcyclic(existing);
      for (const task of accepted) if (!this.get(task.taskId)) this.write(task);
      return accepted.map(task => this.get(task.taskId)!);
    });
  }
  claim(taskId: string, options: ConversationTaskClaimOptions = {}): ConversationTask | undefined {
    const current = this.get(taskId); if (!current) return;
    return this.transaction(current.parentRunId, options, () => {
      const task = this.get(taskId);
      if (!task || task.executionState !== "queued" || (options.expectedPlanGeneration !== undefined && task.planGeneration !== options.expectedPlanGeneration)) return;
      if (options.budgetReservation && !options.budgetLimit) throw new Error("Budget reservation requires a parent limit");
      if (options.budgetLimit && options.budgetReservation) this.assertBudget(task.parentRunId, options.budgetLimit, options.budgetReservation, options.accountedUsage ?? ConversationTaskUsageSchema.parse({}));
      const at = new Date().toISOString(), attemptId = options.attemptId ?? `attempt_${randomUUID()}`, childRunId = options.childRunId ?? `run_${randomUUID()}`;
      const conflict = this.db.prepare("SELECT task_id FROM conversation_task_attempts WHERE attempt_id=? OR child_run_id=?").get(attemptId, childRunId);
      if (conflict) throw new Error("Conversation task attempt identity already exists");
      const next: ConversationTask = { ...task, executionState: "running", attemptId, childRunId, updatedAt: at,
        attempts: [...task.attempts, { attemptId, childRunId, claimedAt: at, executionState: "running", reservationState: options.budgetReservation ? "held" : "released",
          ...(options.budgetReservation ? { reservation: options.budgetReservation } : {}), ...(task.retryReason ? { retryReason: task.retryReason } : {}), accountedUsage: ConversationTaskUsageSchema.parse({}) }] };
      delete next.startedAt; delete next.finishedAt; delete next.error; delete next.blockedReason;
      this.write(next); return this.get(taskId)!;
    });
  }
  update(taskId: string, patch: ConversationTaskPatch, options: ConversationTaskUpdateOptions = {}): ConversationTask {
    const initial = this.get(taskId); if (!initial) throw new Error("Conversation task does not exist or was withdrawn");
    return this.transaction(initial.parentRunId, options, () => {
      const task = this.get(taskId)!;
      if (options.expectedAttemptId !== undefined && options.expectedAttemptId !== task.attemptId) throw new Error("Stale conversation task attempt");
      if (options.expectedPlanGeneration !== undefined && options.expectedPlanGeneration !== task.planGeneration) throw new Error("Stale conversation task plan generation");
      const state = patch.executionState ?? task.executionState;
      if (state === "running" && task.executionState !== "running") throw new Error("Running tasks must be claimed atomically");
      if (state !== task.executionState && !transitions[task.executionState].has(state)) throw new Error(`Invalid conversation task transition: ${task.executionState} -> ${state}`);
      if (state === "queued" && ["failed", "interrupted"].includes(task.executionState) && !patch.retryReason?.trim()) throw new Error("Retry requires an explicit reason after artifact inspection");
      if (task.attemptId && state !== "queued" && options.expectedAttemptId !== task.attemptId) throw new Error("Updating a claimed task requires its attempt identity");
      const { accountedUsage, ...fields } = patch;
      const at = new Date().toISOString(), next: ConversationTask = { ...task, ...fields, executionState: state, updatedAt: at };
      if (next.attemptId) next.attempts = next.attempts.map(attempt => {
        if (attempt.attemptId !== next.attemptId) return attempt;
        const usage = this.usageWatermark(attempt.accountedUsage, accountedUsage ?? {});
        return { ...attempt, executionState: state === "queued" ? attempt.executionState : state, accountedUsage: usage,
          ...(next.startedAt ? { startedAt: next.startedAt } : {}), ...(next.summary ? { summary: next.summary } : {}),
          ...(next.error ? { error: next.error } : {}), ...(next.patch !== undefined ? { patch: next.patch } : {}),
          ...(next.workspacePath ? { workspacePath: next.workspacePath } : {}), ...(next.baselineTree ? { baselineTree: next.baselineTree } : {}),
          ...(finalStates.has(state) || state === "awaiting_integration" ? { finishedAt: attempt.finishedAt ?? patch.finishedAt ?? at, reservationState: state === "completed" || state === "failed" || state === "awaiting_integration" ? "settled" as const : "released" as const } : {}) };
      });
      if (finalStates.has(state)) next.finishedAt = task.finishedAt ?? patch.finishedAt ?? at;
      if (state === "queued") { delete next.attemptId; delete next.childRunId; delete next.startedAt; delete next.finishedAt; delete next.error; }
      this.write(ConversationTaskSchema.parse(next)); return this.get(taskId)!;
    });
  }
  /** Accounting is allowed for historical/withdrawn attempts; it never revives their outputs. */
  account(taskId: string, attemptId: string, actual: Partial<ConversationTaskUsage>, options: ConversationTaskAccountOptions = {}): ConversationTaskAccountResult {
    const original = this.get(taskId, true); if (!original) throw new Error("Conversation task accounting identity does not exist");
    let related: ConversationTaskCommit = options;
    let committedCheckpoint: RunCheckpoint | undefined;
    return this.transaction(original.parentRunId, {}, () => {
      const task = this.get(taskId, true)!, attempt = task.attempts.find(item => item.attemptId === attemptId);
      if (!attempt) throw new Error("Conversation task accounting attempt does not exist");
      const usage = this.usageWatermark(attempt.accountedUsage, actual), delta = ConversationTaskUsageSchema.parse({});
      for (const key of ["inputTokens", "outputTokens", "estimatedUsd", "turns", "toolCalls", "durationMs", "cachedInputTokens"] as const) delta[key] = usage[key] - attempt.accountedUsage[key];
      if (usage.costKnown !== undefined) delta.costKnown = usage.costKnown;
      if (options.applyUsageToCheckpoint) {
        if (!options.checkpoint || options.checkpoint.runId !== task.parentRunId) throw new Error("Usage recovery requires its parent checkpoint");
        const checkpoint = options.checkpoint;
        committedCheckpoint = { ...checkpoint, turns: checkpoint.turns + delta.turns, toolCalls: checkpoint.toolCalls + delta.toolCalls,
          usage: { ...checkpoint.usage, inputTokens: checkpoint.usage.inputTokens + delta.inputTokens, outputTokens: checkpoint.usage.outputTokens + delta.outputTokens,
            estimatedUsd: checkpoint.usage.estimatedUsd + delta.estimatedUsd, cachedInputTokens: (checkpoint.usage.cachedInputTokens ?? 0) + delta.cachedInputTokens,
            costKnown: checkpoint.usage.costKnown !== false && usage.costKnown !== false } };
        related = { ...options, checkpoint: committedCheckpoint };
      }
      this.write({ ...task, updatedAt: new Date().toISOString(), attempts: task.attempts.map(item => item.attemptId === attemptId ? { ...item, accountedUsage: usage } : item) });
      this.commitRelated(related, task.parentRunId);
      return { task: this.get(taskId, true)!, delta, ...(committedCheckpoint ? { checkpoint: committedCheckpoint } : {}) };
    });
  }
  interrupt(parentRunId: string, reason: string, options: ConversationTaskCommit = {}): ConversationTask[] {
    return this.transaction(parentRunId, options, () => this.list(parentRunId).filter(task => task.executionState === "running").map(task => {
      const at = new Date().toISOString();
      this.write({ ...task, executionState: "interrupted", error: reason, finishedAt: at, updatedAt: at,
        attempts: task.attempts.map(attempt => attempt.attemptId === task.attemptId ? { ...attempt, executionState: "interrupted", error: reason, finishedAt: at, reservationState: "released" } : attempt) });
      return this.get(task.taskId)!;
    }));
  }
  recover(): void {
    const parents = this.db.prepare("SELECT DISTINCT parent_run_id FROM conversation_tasks WHERE execution_state='running' AND withdrawn_at IS NULL").all();
    for (const row of parents) this.interrupt(String(row.parent_run_id), "Daemon restarted; inspect persisted child artifacts before retrying");
  }
  /** Called inside the existing withdrawal transaction. Spent usage is immutable across branches. */
  restore(parentRunId: string, baseline: ConversationTask[]): void {
    const current = this.list(parentRunId, true), retained = new Set(baseline.map(task => task.taskId)), at = new Date().toISOString();
    for (const task of current) if (!retained.has(task.taskId) && !task.withdrawnAt) this.write({ ...task, withdrawnAt: at, executionState: "cancelled", updatedAt: at,
      attempts: task.attempts.map(attempt => ({ ...attempt, reservationState: "released" })) });
    for (const original of baseline) {
      const latest = current.find(task => task.taskId === original.taskId);
      const attempts = original.attempts.map(attempt => {
        const newer = latest?.attempts.find(item => item.attemptId === attempt.attemptId);
        if (!newer) return attempt;
        const usage = this.usageWatermark(attempt.accountedUsage, newer.accountedUsage);
        return { ...attempt, accountedUsage: usage, reservationState: "released" as const };
      });
      // Attempts created after the boundary retain their real accounting, without reviving their outputs.
      for (const attempt of latest?.attempts ?? []) if (!attempts.some(item => item.attemptId === attempt.attemptId)) attempts.push({ ...attempt, reservationState: "released" });
      const startedAfterBoundary = ["queued", "blocked"].includes(original.executionState) && attempts.length > original.attempts.length;
      this.write({ ...original, attempts, updatedAt: at, ...(startedAfterBoundary ? { executionState: "interrupted", summary: "Execution began after this message boundary; inspect saved attempts before explicitly retrying" } : {}) });
    }
  }
  private transaction<T>(parent: string, related: ConversationTaskCommit, action: () => T): T {
    this.flush(); this.assertParent(parent); this.db.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.commitRelated(related, parent); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private key(task: ConversationTask): string { return createHash("sha256").update(JSON.stringify([task.parentRunId, task.submissionKey ?? [task.planGeneration, task.source.kind, task.source.messageId ?? "", task.stepId]])).digest("hex"); }
  private usageWatermark(previous: ConversationTaskUsage, actual: Partial<ConversationTaskUsage>): ConversationTaskUsage {
    const usage = ConversationTaskUsageSchema.parse({ ...previous, ...actual });
    for (const key of ["inputTokens", "outputTokens", "estimatedUsd", "turns", "toolCalls", "durationMs", "cachedInputTokens"] as const) usage[key] = Math.max(previous[key], usage[key]);
    if (previous.costKnown === false || actual.costKnown === false) usage.costKnown = false;
    return usage;
  }
  private write(task: ConversationTask): void {
    const version = this.version(task.parentRunId) + 1;
    this.db.prepare("INSERT INTO conversation_task_queues (parent_run_id,version) VALUES (?,?) ON CONFLICT(parent_run_id) DO UPDATE SET version=excluded.version").run(task.parentRunId, version);
    task = { ...task, queueVersion: version, enqueueOrder: task.enqueueOrder ?? version };
    for (const attempt of task.attempts) this.db.prepare("INSERT INTO conversation_task_attempts (attempt_id,child_run_id,task_id) VALUES (?,?,?) ON CONFLICT(attempt_id) DO NOTHING").run(attempt.attemptId, attempt.childRunId, task.taskId);
    this.db.prepare(`INSERT INTO conversation_tasks (id,parent_run_id,session_id,execution_state,priority,plan_generation,submission_key,attempt_id,child_run_id,created_at,withdrawn_at,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET execution_state=excluded.execution_state,priority=excluded.priority,plan_generation=excluded.plan_generation,attempt_id=excluded.attempt_id,child_run_id=excluded.child_run_id,withdrawn_at=excluded.withdrawn_at,payload=excluded.payload`)
      .run(task.taskId, task.parentRunId, task.sessionId, task.executionState, task.priority, task.planGeneration, this.key(task), task.attemptId ?? null, task.childRunId ?? null, task.createdAt, task.withdrawnAt ?? null, this.crypto.encryptJson(task, `conversation_task:${task.taskId}`));
  }
  private assertAcyclic(tasks: ConversationTask[]): void {
    const nodes = new Map<string, ConversationTask>(), steps = new Map<string, ConversationTask>();
    for (const task of tasks) { nodes.set(task.taskId, task); steps.set(JSON.stringify([task.planGeneration, task.stepId]), task); }
    const visiting = new Set<string>(), complete = new Set<string>();
    const visit = (task: ConversationTask) => { if (visiting.has(task.taskId)) throw new Error("Conversation task dependencies contain a cycle"); if (complete.has(task.taskId)) return;
      visiting.add(task.taskId); for (const id of task.dependsOn) { const next = steps.get(JSON.stringify([task.planGeneration, id])) ?? nodes.get(id); if (next) visit(next); } visiting.delete(task.taskId); complete.add(task.taskId); };
    for (const task of tasks) visit(task);
  }
  private assertBudget(parent: string, limit: ConversationTaskBudget, reservation: ConversationTaskBudget, usage: ConversationTaskUsage): void {
    ConversationTaskBudgetSchema.parse(limit); ConversationTaskBudgetSchema.parse(reservation);
    const held = { maxTurns: 0, maxToolCalls: 0, maxDurationMs: 0, maxUsd: 0 };
    for (const task of this.list(parent)) for (const attempt of task.attempts) if (attempt.reservationState === "held" && attempt.reservation) {
      held.maxTurns += Math.max(0, attempt.reservation.maxTurns - attempt.accountedUsage.turns); held.maxToolCalls += Math.max(0, attempt.reservation.maxToolCalls - attempt.accountedUsage.toolCalls);
      held.maxDurationMs += Math.max(0, attempt.reservation.maxDurationMs - attempt.accountedUsage.durationMs); held.maxUsd += Math.max(0, attempt.reservation.maxUsd - attempt.accountedUsage.estimatedUsd);
    }
    const actual = { maxTurns: 0, maxToolCalls: 0, maxDurationMs: 0, maxUsd: 0 };
    for (const task of this.list(parent, true)) for (const attempt of task.attempts) {
      actual.maxTurns += attempt.accountedUsage.turns; actual.maxToolCalls += attempt.accountedUsage.toolCalls;
      actual.maxDurationMs += attempt.accountedUsage.durationMs; actual.maxUsd += attempt.accountedUsage.estimatedUsd;
    }
    const spent = { maxTurns: Math.max(usage.turns, actual.maxTurns), maxToolCalls: Math.max(usage.toolCalls, actual.maxToolCalls), maxDurationMs: Math.max(usage.durationMs, actual.maxDurationMs), maxUsd: Math.max(usage.estimatedUsd, actual.maxUsd) };
    for (const key of ["maxTurns", "maxToolCalls", "maxDurationMs", "maxUsd"] as const) if (!Number.isFinite(reservation[key]) || reservation[key] < 0 || spent[key] + held[key] + reservation[key] > limit[key] + 1e-9) throw new Error(`Conversation task budget exhausted: ${key}`);
  }
}
