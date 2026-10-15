import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentEvent,
  ApprovalRequest,
  AttachmentRef,
  CompactionRecord,
  EvalResult,
  MemoryRecord,
  MemoryScopeSelection,
  PlanSpec,
  PluginRecord,
  McpServerConfig,
  Profile,
  RunCheckpoint,
  RunHistoryPage,
  SessionDetail,
  SessionView,
  SessionCursor,
  RunEventPage,
  SessionPage,
  SessionRecord,
  ProjectRecord,
  RunSpec,
  RunStatus,
  RunWithdrawal,
  SkillManifest,
  TaskSpec,
  VerificationRun,
} from "@harness/protocol";
import {
  ProfileSchema,
  isCommittedContextAdjustment,
  migrateContextPolicy,
  ProjectRecordSchema,
  SessionRecordSchema,
} from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";
import { SQLiteFile, type StorageProgress } from "./sqlite.js";

interface RunRow {
  id: string;
  status: RunStatus;
  payload: string;
}
interface EventRow {
  payload: string;
}
interface GenericRow {
  id: string;
  payload: string;
}
export interface SteeringWithdrawalBoundary {
  runId: string;
  messageId: string;
  checkpointId: string;
  beforeSequence: number;
  descendantRunIds: string[];
  memoryIds: string[];
}
const steeringRestoreTables = ["plans", "approvals", "compactions", "verification_runs", "traces"] as const;
type SteeringRestoreTable = typeof steeringRestoreTables[number];
interface StoredSteeringWithdrawal extends SteeringWithdrawalBoundary {
  sessionId: string;
  runs: Array<{ runId: string; status: RunStatus; beforeSequence: number; checkpointId?: string; checkpointIds: string[] }>;
  records: Record<SteeringRestoreTable, Array<Record<string, unknown> & { id: string; runId: string }>>;
}
type GenericTable =
  | "profiles"
  | "approvals"
  | "memories"
  | "skills"
  | "tasks"
  | "attachments"
  | "plans"
  | "checkpoints"
  | "compactions"
  | "verification_runs"
  | "plugins"
  | "mcp_servers"
  | "mcp_auth"
  | "eval_results"
  | "traces"
  | "sessions"
  | "projects";
const liveStatuses = new Set<RunStatus>([
  "queued",
  "planning",
  "running",
  "waiting_approval",
  "verifying",
]);

/** The tool call an event belongs to: `tool_started` carries it inside `call`, `tool_finished` beside it. */
function toolCallId(event: AgentEvent): string | undefined {
  if (event.type === "tool_started") return event.call.id;
  if (event.type === "tool_finished") return event.callId;
  return undefined;
}

export class HarnessDatabase {
  private readonly db: SQLiteFile;
  private pendingEvents: AgentEvent[] = [];
  private pendingBytes = 0;
  private eventTimer: ReturnType<typeof setTimeout> | undefined;
  private flushError?: unknown;
  private closed = false;
  private outputPages = new Map<string, string>();
  private outputCharacters = 0;

  private clearOutputPages() { this.outputPages.clear(); this.outputCharacters = 0; }

  private constructor(
    database: SQLiteFile,
    private readonly crypto: VaultCrypto,
    private readonly onProgress?: (progress: StorageProgress) => void,
  ) {
    this.db = database;
    this.migrate();
  }

  static async open(
    path: string,
    crypto: VaultCrypto,
    onProgress?: (progress: StorageProgress) => void,
  ): Promise<HarnessDatabase> {
    await mkdir(dirname(path), { recursive: true });
    const file = await SQLiteFile.open(path, staged => { new HarnessDatabase(staged, crypto, onProgress); }, onProgress);
    return new HarnessDatabase(file, crypto, onProgress);
  }

  close(): void {
    if (this.closed) return;
    this.flushEvents();
    this.clearOutputPages();
    this.db.close();
    this.closed = true;
  }

  saveProfile(profile: Profile): void {
    const normalized = ProfileSchema.parse(profile);
    this.upsert("profiles", normalized.id, normalized);
  }

  listProfiles(): Profile[] {
    return this.list<unknown>("profiles").map((stored) => {
      const migrated = migrateContextPolicy(stored);
      const normalized = ProfileSchema.parse(migrated);
      if (
        !stored ||
        typeof stored !== "object" ||
        !("resiliencePolicy" in stored) || migrated !== stored
      ) {
        this.upsert("profiles", normalized.id, normalized);
      }
      return normalized;
    });
  }

  saveRun(spec: RunSpec, status: RunStatus = "queued"): void {
    if (this.isRunWithdrawn(spec.id)) throw new Error("已撤回的运行不能重新保存");
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO runs (id, status, payload, created_at, updated_at, session_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at, session_id=excluded.session_id",
      )
      .run(
        spec.id,
        status,
        this.crypto.encryptJson(spec, `run:${spec.id}`),
        spec.createdAt,
        now,
        spec.sessionId,
      );
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    if (this.isRunWithdrawn(runId)) throw new Error("已撤回的运行不能改变状态");
    this.flushEvents();
    this.db
      .prepare("UPDATE runs SET status=?, updated_at=? WHERE id=?")
      .run(status, new Date().toISOString(), runId);
    const run = this.getRun(runId);
    if (run && this.get<SessionRecord>("sessions", run.spec.sessionId))
      this.touchSession(run.spec.sessionId, {
        updatedAt: new Date().toISOString(),
      });
  }

  getRun(runId: string): { spec: RunSpec; status: RunStatus } | undefined {
    this.flushEvents();
    if (this.isRunWithdrawn(runId)) return;
    const row = this.db
      .prepare("SELECT id, status, payload FROM runs WHERE id=?")
      .get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return {
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    };
  }

  isRunWithdrawn(runId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM withdrawn_runs WHERE run_id=?").get(runId));
  }

  /** Includes the visible root and every descendant, even if a child has a different session ID. */
  getRunDescendants(runId: string): Array<{ spec: RunSpec; status: RunStatus }> {
    this.flushEvents();
    const all = this.allRuns();
    if (!all.some(item => item.spec.id === runId)) return [];
    const ids = new Set([runId]);
    let size = 0;
    while (size !== ids.size) {
      size = ids.size;
      for (const item of all) if (item.spec.parentRunId && ids.has(item.spec.parentRunId)) ids.add(item.spec.id);
    }
    return all.filter(item => ids.has(item.spec.id));
  }

  /** Commit only after the engine has stopped and restored the workspace. Audit and spent usage remain. */
  withdrawLatestRun(runId: string): RunWithdrawal {
    this.flushEvents();
    const run = this.getRun(runId);
    if (!run || run.spec.parentRunId || run.status !== "paused") throw new Error("只能撤回已暂停的最新一轮对话");
    if (!this.visibleSession(run.spec.sessionId)) throw new Error("会话不存在或已删除");
    const latest = this.runsForSession(run.spec.sessionId).filter(item => !item.spec.parentRunId).at(-1);
    if (latest?.spec.id !== runId) throw new Error("只能撤回最新一轮对话");
    if (this.latestSteeringEvent(runId)) throw new Error("本轮已有追加消息，请撤回最新一条消息");
    const tree = this.getRunDescendants(runId);
    const ids = new Set(tree.map(item => item.spec.id));
    if (tree.some(item => liveStatuses.has(item.status))) throw new Error("本轮仍有运行中的任务，请等待暂停完成");
    const memories = this.listMemories().filter(memory => ids.has(memory.source.replace(/^run:/, "")) && memory.source.startsWith("run:"));
    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of tree) {
        this.db.prepare("INSERT INTO withdrawn_runs (run_id,session_id,withdrawn_at) VALUES (?,?,?)").run(item.spec.id, item.spec.sessionId, at);
        this.db.prepare("UPDATE runs SET status='cancelled',updated_at=? WHERE id=?").run(at, item.spec.id);
      }
      for (const memory of memories) {
        this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(memory.id);
        this.db.prepare("DELETE FROM memories WHERE id=?").run(memory.id);
      }
      this.touchSession(run.spec.sessionId, { updatedAt: at });
      this.db.exec("COMMIT");
      this.clearOutputPages();
      return { run: run.spec, withdrawnRunIds: [...ids] };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Freeze the durable paused state before a safely snapshotted additional message is submitted. */
  prepareSteeringWithdrawal(runId: string, messageId: string, checkpointId: string): void {
    this.flushEvents();
    const run = this.assertSteeringWithdrawalRun(runId);
    const checkpoint = this.getLatestCheckpoint(runId);
    if (!checkpoint || checkpoint.id !== checkpointId || checkpoint.status !== "paused") throw new Error("追加消息前的暂停检查点已改变");
    const tree = this.getRunDescendants(runId);
    if (tree.some(item => liveStatuses.has(item.status))) throw new Error("本轮仍有运行中的任务，请等待暂停完成");
    const ids = new Set(tree.map(item => item.spec.id));
    const records = Object.fromEntries(steeringRestoreTables.map(table => [table,
      this.list<Record<string, unknown> & { id: string; runId: string }>(table).filter(record => ids.has(record.runId)),
    ])) as StoredSteeringWithdrawal["records"];
    const runs = tree.map(item => ({
      runId: item.spec.id, status: item.status, beforeSequence: this.lastEventSequence(item.spec.id),
      ...(this.getLatestCheckpoint(item.spec.id) ? { checkpointId: this.getLatestCheckpoint(item.spec.id)!.id } : {}),
      checkpointIds: (this.db.prepare("SELECT id FROM checkpoints WHERE run_id=?").all(item.spec.id) as Array<{ id: string }>).map(row => row.id),
    }));
    const state: StoredSteeringWithdrawal = {
      runId, messageId, checkpointId, beforeSequence: this.lastEventSequence(runId), sessionId: run.spec.sessionId,
      descendantRunIds: [...ids].filter(id => id !== runId),
      memoryIds: this.listMemories().filter(memory => memory.source.startsWith("run:") && ids.has(memory.source.slice(4))).map(memory => memory.id),
      runs, records,
    };
    const id = JSON.stringify([runId, messageId]);
    this.db.prepare("INSERT INTO steering_withdrawals (id,run_id,session_id,payload) VALUES (?,?,?,?)").run(
      id, runId, run.spec.sessionId, this.crypto.encryptJson(state, `steering_withdrawals:${id}`),
    );
  }

  getSteeringWithdrawal(runId: string, messageId?: string): SteeringWithdrawalBoundary | undefined {
    this.flushEvents();
    const id = messageId ?? this.latestSteeringEvent(runId)?.messageId;
    if (!id) return;
    const state = this.steeringWithdrawal(runId, id);
    if (!state) return;
    return { runId: state.runId, messageId: state.messageId, checkpointId: state.checkpointId,
      beforeSequence: state.beforeSequence, descendantRunIds: [...state.descendantRunIds], memoryIds: [...state.memoryIds] };
  }

  discardSteeringWithdrawal(runId: string, messageId: string): void {
    this.db.prepare("DELETE FROM steering_withdrawals WHERE id=?").run(JSON.stringify([runId, messageId]));
  }

  /** The filesystem has already been restored; commit the matching conversation branch atomically. */
  withdrawLatestSteering(runId: string, messageId: string): RunWithdrawal & { messageId: string; text: string } {
    this.flushEvents();
    const run = this.assertSteeringWithdrawalRun(runId);
    const message = this.latestSteeringEvent(runId);
    if (message?.type !== "steering_submitted" || message.messageId !== messageId) throw new Error("只能撤回最新一条追加消息");
    const state = this.steeringWithdrawal(runId, messageId);
    if (!state || state.sessionId !== run.spec.sessionId || message.sequence <= state.beforeSequence) throw new Error("本条消息没有可恢复的暂停记录，无法安全撤回");
    const tree = this.getRunDescendants(runId);
    if (tree.some(item => liveStatuses.has(item.status))) throw new Error("本轮仍有运行中的任务，请等待暂停完成");
    const baselineIds = new Set(state.runs.map(item => item.runId));
    if (state.runs.some(item => !tree.some(current => current.spec.id === item.runId))) throw new Error("暂停前的子任务记录已改变，无法安全撤回");
    const added = tree.filter(item => !baselineIds.has(item.spec.id));
    const allIds = new Set(tree.map(item => item.spec.id));
    const contentCandidates = this.contentReferences(baselineIds);
    const priorMemoryIds = new Set(state.memoryIds);
    const memories = this.listMemories().filter(memory => memory.source.startsWith("run:") && allIds.has(memory.source.slice(4)) && !priorMemoryIds.has(memory.id));
    const at = new Date().toISOString();
    // Resolve every immutable baseline before changing rows. A missing checkpoint must never
    // silently turn a message withdrawal into a full conversation reset.
    const restored = state.runs.map(item => {
      const baseline = item.checkpointId ? this.get<RunCheckpoint>("checkpoints", item.checkpointId) : undefined;
      const latest = this.getLatestCheckpoint(item.runId);
      if (item.runId === runId && (!baseline || baseline.runId !== runId)) throw new Error("追加消息前的检查点不存在，无法安全撤回");
      const sequence = Math.max(this.lastEventSequence(item.runId), latest?.sequence ?? -1, baseline?.sequence ?? -1,
        Number(this.db.prepare("SELECT MAX(sequence) AS sequence FROM withdrawn_message_events WHERE run_id=?").get(item.runId)?.sequence ?? -1)) + 1;
      const workflow = baseline?.workflow ? structuredClone(baseline.workflow) : undefined;
      // Child costs already charged to the parent must keep their accounting watermark even
      // though the child execution's conversational/verification state returns to the baseline.
      for (const execution of workflow?.sequential?.taskExecutions ?? []) {
        if (!execution.childRunId) continue;
        const ledgers = [execution.accountedUsage, ...(latest?.workflow?.sequential?.taskExecutions ?? [])
          .filter(current => current.childRunId === execution.childRunId).map(current => current.accountedUsage)]
          .filter((usage): usage is NonNullable<typeof usage> => Boolean(usage));
        if (!ledgers.length) continue;
        execution.accountedUsage = {
          inputTokens: Math.max(...ledgers.map(usage => usage.inputTokens)), outputTokens: Math.max(...ledgers.map(usage => usage.outputTokens)),
          estimatedUsd: Math.max(...ledgers.map(usage => usage.estimatedUsd)), turns: Math.max(...ledgers.map(usage => usage.turns)),
          toolCalls: Math.max(...ledgers.map(usage => usage.toolCalls)), costKnown: ledgers.every(usage => usage.costKnown !== false),
        };
      }
      const checkpoint: RunCheckpoint | undefined = baseline ? {
        ...baseline, id: `checkpoint_withdraw_${randomUUID()}`, sequence, status: item.status, reason: "manual", createdAt: at,
        ...(workflow ? { workflow } : {}),
        usage: latest ? { ...latest.usage,
          inputTokens: Math.max(baseline.usage.inputTokens, latest.usage.inputTokens),
          outputTokens: Math.max(baseline.usage.outputTokens, latest.usage.outputTokens),
          estimatedUsd: Math.max(baseline.usage.estimatedUsd, latest.usage.estimatedUsd) } : baseline.usage,
        turns: Math.max(baseline.turns, latest?.turns ?? 0), toolCalls: Math.max(baseline.toolCalls, latest?.toolCalls ?? 0),
        ...(baseline.elapsedMs !== undefined || latest?.elapsedMs !== undefined ? { elapsedMs: Math.max(baseline.elapsedMs ?? 0, latest?.elapsedMs ?? 0) } : {}),
        ...(baseline.repairAttemptsUsed !== undefined || latest?.repairAttemptsUsed !== undefined ? { repairAttemptsUsed: Math.max(baseline.repairAttemptsUsed ?? 0, latest?.repairAttemptsUsed ?? 0) } : {}),
      } : undefined;
      return { ...item, checkpoint };
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of restored) {
        this.archiveWithdrawnMessageEvents(item.runId, tree.find(current => current.spec.id === item.runId)!.spec.sessionId, item.beforeSequence);
        this.db.prepare("DELETE FROM tool_evidence WHERE run_id=? AND sequence>?").run(item.runId, item.beforeSequence);
        this.db.prepare("DELETE FROM events WHERE run_id=? AND sequence>?").run(item.runId, item.beforeSequence);
        const kept = new Set(item.checkpointIds);
        for (const row of this.db.prepare("SELECT id FROM checkpoints WHERE run_id=?").all(item.runId)) {
          if (!kept.has(String(row.id))) this.db.prepare("DELETE FROM checkpoints WHERE id=?").run(row.id);
        }
        this.db.prepare("UPDATE runs SET status=?,updated_at=? WHERE id=?").run(item.status, at, item.runId);
        if (item.checkpoint) {
          this.upsert("checkpoints", item.checkpoint.id, item.checkpoint);
          this.writeEvent({ id: `event_withdraw_${randomUUID()}`, runId: item.runId, sequence: item.checkpoint.sequence, at,
            type: "checkpoint_saved", checkpointId: item.checkpoint.id, reason: "manual", messages: item.checkpoint.transcript.length });
        }
      }
      for (const table of steeringRestoreTables) {
        for (const record of this.list<Record<string, unknown> & { id: string; runId?: string }>(table)) {
          if (record.runId && baselineIds.has(record.runId)) this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(record.id);
        }
        for (const record of state.records[table]) this.upsert(table, record.id, record);
      }
      for (const item of added) {
        this.db.prepare("INSERT INTO withdrawn_runs (run_id,session_id,withdrawn_at) VALUES (?,?,?)").run(item.spec.id, item.spec.sessionId, at);
        this.db.prepare("UPDATE runs SET status='cancelled',updated_at=? WHERE id=?").run(at, item.spec.id);
      }
      for (const memory of memories) {
        this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(memory.id);
        this.db.prepare("DELETE FROM memories WHERE id=?").run(memory.id);
      }
      this.discardSteeringWithdrawal(runId, messageId);
      this.touchSession(run.spec.sessionId, { updatedAt: at });
      const retainedContent = this.contentReferences();
      for (const id of contentCandidates) if (!retainedContent.has(id)) this.db.prepare("DELETE FROM content_objects WHERE id=?").run(id);
      this.db.exec("COMMIT");
      this.contentAddresses = new WeakMap();
      this.clearOutputPages();
      return { run: run.spec, withdrawnRunIds: added.map(item => item.spec.id), messageId, text: message.text };
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.contentAddresses = new WeakMap();
      throw error;
    }
  }

  private assertSteeringWithdrawalRun(runId: string): { spec: RunSpec; status: RunStatus } {
    const run = this.getRun(runId);
    if (!run || run.spec.parentRunId || run.status !== "paused") throw new Error("只能撤回已暂停的最新一轮对话");
    if (!this.visibleSession(run.spec.sessionId)) throw new Error("会话不存在或已删除");
    const latest = this.runsForSession(run.spec.sessionId).filter(item => !item.spec.parentRunId).at(-1);
    if (latest?.spec.id !== runId) throw new Error("只能撤回最新一轮对话");
    return run;
  }

  private lastEventSequence(runId: string): number {
    return Number(this.db.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE run_id=?").get(runId)?.sequence ?? -1);
  }

  private latestSteeringEvent(runId: string): Extract<AgentEvent, { type: "steering_submitted" | "steering_delivered" }> | undefined {
    const rows = this.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND type IN ('steering_submitted','steering_delivered') ORDER BY sequence").all(runId) as unknown as Array<EventRow & { sequence: number }>;
    const events = rows.map(row => this.decodeEvent(row.payload, runId, row.sequence)) as Array<Extract<AgentEvent, { type: "steering_submitted" | "steering_delivered" }>>;
    const submitted = new Set(events.flatMap(event => event.type === "steering_submitted" ? [event.messageId] : []));
    // Delivering an older queued message after the latest submission does not make that older
    // bubble the withdrawal target. Legacy delivery-only messages remain distinct boundaries.
    return events.findLast(event => event.type === "steering_submitted" || !event.messageId || !submitted.has(event.messageId));
  }

  private steeringWithdrawal(runId: string, messageId: string): StoredSteeringWithdrawal | undefined {
    const id = JSON.stringify([runId, messageId]);
    const row = this.db.prepare("SELECT payload FROM steering_withdrawals WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? this.crypto.decryptJson<StoredSteeringWithdrawal>(row.payload, `steering_withdrawals:${id}`) : undefined;
  }

  private archiveWithdrawnMessageEvents(runId: string, sessionId: string, afterSequence: number): void {
    const rows = this.db.prepare("SELECT sequence,payload,created_at,type FROM events WHERE run_id=? AND sequence>? AND type IN ('usage','context_compacted') ORDER BY sequence").all(runId, afterSequence) as unknown as Array<EventRow & { sequence: number; created_at: string; type: string }>;
    for (const row of rows) {
      const event = this.decodeEvent(row.payload, runId, row.sequence);
      const safe = event.type === "context_compacted" ? { ...event, record: { ...event.record, summary: "" } } : event;
      this.db.prepare("INSERT INTO withdrawn_message_events (run_id,sequence,session_id,type,payload,created_at) VALUES (?,?,?,?,?,?)").run(
        runId, row.sequence, sessionId, row.type, this.crypto.encryptJson(safe, `event:${runId}:${row.sequence}`), row.created_at,
      );
    }
  }

  private withdrawnEvents(sessionId: string): AgentEvent[] {
    const rows = this.db.prepare(`SELECT e.run_id,e.sequence,e.payload FROM events e
      JOIN withdrawn_runs w ON w.run_id=e.run_id
      WHERE w.session_id=? AND e.type IN ('usage','context_compacted')
      ORDER BY e.created_at,e.run_id,e.sequence`).all(sessionId) as unknown as Array<EventRow & { run_id: string; sequence: number }>;
    const archived = this.db.prepare("SELECT run_id,sequence,payload FROM withdrawn_message_events WHERE session_id=? ORDER BY created_at,run_id,sequence").all(sessionId) as unknown as Array<EventRow & { run_id: string; sequence: number }>;
    return [...rows, ...archived].map(row => {
      const event = this.decodeEvent(row.payload, row.run_id, row.sequence);
      // The statistics panel needs the count and usage, never the withdrawn summary itself.
      return event.type === "context_compacted" ? { ...event, record: { ...event.record, summary: "" } } : event;
    });
  }

  listRunHistory(limit = 50, offset = 0): RunHistoryPage {
    this.flushEvents();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid history pagination");
    const rows = this.db
      .prepare(
        "SELECT id, status, payload FROM runs WHERE id NOT IN (SELECT run_id FROM withdrawn_runs) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(limit + 1, offset) as unknown as RunRow[];
    return {
      items: rows.slice(0, limit).map((row) => {
        const spec = this.crypto.decryptJson<RunSpec>(
          row.payload,
          `run:${row.id}`,
        );
        return {
          id: spec.id,
          sessionId: spec.sessionId,
          request: spec.request,
          workspacePath: spec.workspacePath,
          profileId: spec.profileId,
          createdAt: spec.createdAt,
          status: row.status,
        };
      }),
      hasMore: rows.length > limit,
    };
  }

  listInterruptedRuns(): Array<{ spec: RunSpec; status: RunStatus }> {
    this.flushEvents();
    const rows = this.db
      .prepare(
        "SELECT id, status, payload FROM runs WHERE status IN ('planning','running','waiting_approval','verifying')",
      )
      .all() as unknown as RunRow[];
    return rows.map((row) => ({
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    }));
  }

  ensureProject(
    workspacePath: string,
    at = new Date().toISOString(),
  ): ProjectRecord {
    const id = projectId(workspacePath);
    const current = this.get<ProjectRecord>("projects", id);
    if (current) return current;
    const project = ProjectRecordSchema.parse({
      id,
      workspacePath,
      createdAt: at,
      updatedAt: at,
    });
    this.upsert("projects", id, project);
    return project;
  }

  listProjects(deleted = false): ProjectRecord[] {
    return this.list<ProjectRecord>("projects")
      .map((record) => ProjectRecordSchema.parse(record))
      .filter((record) => Boolean(record.deletedAt) === deleted)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
  }

  createSession(input: SessionRecord): SessionRecord {
    const session = SessionRecordSchema.parse(input);
    if (this.get<SessionRecord>("sessions", session.id))
      throw new Error(`Session already exists: ${session.id}`);
    const project = this.ensureProject(
      session.workspacePath,
      session.createdAt,
    );
    if (project.deletedAt)
      throw new Error("Cannot create a Session in a deleted project");
    this.upsert("sessions", session.id, session);
    return session;
  }

  touchSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "profileId" | "updatedAt" | "skillSelection" | "reasoningEffort">>,
  ): SessionRecord {
    const current = this.get<SessionRecord>("sessions", id);
    if (!current) throw new Error(`Unknown Session: ${id}`);
    const updated = SessionRecordSchema.parse({ ...current, ...patch });
    this.upsert("sessions", id, updated);
    const project = this.ensureProject(
      updated.workspacePath,
      updated.createdAt,
    );
    if (!project.deletedAt)
      this.upsert("projects", project.id, {
        ...project,
        workspacePath: updated.workspacePath,
        updatedAt: updated.updatedAt,
      });
    return updated;
  }

  listSessions(
    input: { deleted?: boolean; limit?: number; offset?: number } = {},
  ): SessionPage {
    const deleted = input.deleted ?? false,
      limit = input.limit ?? 50,
      offset = input.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid Session pagination");
    this.flushEvents();
    const rows = this.db.prepare(`SELECT s.id,s.payload,
      (SELECT count(*) FROM runs r WHERE r.session_id=s.id AND r.id NOT IN (SELECT run_id FROM withdrawn_runs)) AS run_count,
      (SELECT id FROM runs r WHERE r.session_id=s.id AND r.id NOT IN (SELECT run_id FROM withdrawn_runs) ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_id,
      (SELECT status FROM runs r WHERE r.session_id=s.id AND r.id NOT IN (SELECT run_id FROM withdrawn_runs) ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_status
      FROM sessions s WHERE s.deleted=? AND (?=1 OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.deleted=0))
      ORDER BY s.sort_at DESC,s.id DESC LIMIT ? OFFSET ?`).all(Number(deleted), Number(deleted), limit + 1, offset) as unknown as Array<GenericRow & { run_count: number; latest_id: string | null; latest_status: RunStatus }>;
    return {
      items: rows.slice(0, limit).map((row) => {
        const session = SessionRecordSchema.parse(this.decode("sessions", row));
        return {
          ...session,
          runCount: row.run_count,
          ...(row.latest_id
            ? { latestRunId: row.latest_id, latestStatus: row.latest_status }
            : {}),
        };
      }),
      hasMore: rows.length > limit,
    };
  }

  getSessionDetail(id: string): SessionDetail | undefined {
    const session = this.get<SessionRecord>("sessions", id);
    return session
      ? {
          session: SessionRecordSchema.parse(session),
          runs: this.runsForSession(id).map((run) => ({
            ...run,
            events: this.listEvents(run.spec.id),
          })),
          withdrawnEvents: this.withdrawnEvents(id),
        }
      : undefined;
  }

  getSessionView(id: string, limit = 20, before?: SessionCursor): SessionView | undefined {
    this.flushEvents();
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid session view limit");
    const session = this.visibleSession(id);
    if (!session) return;
    const rows = this.db.prepare(`SELECT id,status,payload FROM runs WHERE session_id=? AND id NOT IN (SELECT run_id FROM withdrawn_runs)
      ${before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(id, ...(before ? [before.createdAt, before.createdAt, before.id] : []), limit + 1) as unknown as RunRow[];
    const runs = rows.slice(0, limit).reverse().map(row => {
      const spec = this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`);
      const lastSequence = Number(this.db.prepare("SELECT COALESCE(max(sequence),-1) AS n FROM events WHERE run_id=?").get(row.id)?.n);
      const latest = (type: string, afterSequence = -1, beforeSequence = lastSequence + 1) => {
        const event = this.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND type=? AND sequence>? AND sequence<? ORDER BY sequence DESC LIMIT 1").get(row.id, type, afterSequence, beforeSequence) as (EventRow & { sequence: number }) | undefined;
        return event ? this.decodeEvent(event.payload, row.id, event.sequence) : undefined;
      };
      // Purpose/source fields are encrypted. Search only small telemetry records,
      // in bounded pages, and stop as soon as their useful latest marker is found.
      // A long tail of auxiliary requests or character-only adjustments must not
      // hide the last measured context or committed token adjustment.
      const telemetry = function* (database: HarnessDatabase, type: AgentEvent["type"], afterSequence = -1, beforeSequence = lastSequence + 1): Generator<AgentEvent> {
        const query = database.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND type=? AND sequence>? AND sequence<? ORDER BY sequence DESC LIMIT 32");
        for (;;) {
          const page = query.all(row.id, type, afterSequence, beforeSequence) as unknown as Array<EventRow & { sequence: number }>;
          for (const event of page) yield database.decodeEvent(event.payload, row.id, event.sequence);
          if (page.length < 32) return;
          beforeSequence = page.at(-1)!.sequence;
        }
      };
      const latestMatching = (type: AgentEvent["type"], matches: (event: AgentEvent) => boolean, afterSequence = -1, beforeSequence = lastSequence + 1) => {
        for (const event of telemetry(this, type, afterSequence, beforeSequence)) if (matches(event)) return event;
        return undefined;
      };
      type RouteEvent = Extract<AgentEvent, { type: "route" }>;
      type RouteEpoch = { firstRoute: RouteEvent | undefined; route: RouteEvent | undefined; routeBoundary: number; beforeSequence: number };
      const epochs: RouteEpoch[] = [];
      let route: RouteEvent | undefined, firstRoute: RouteEvent | undefined;
      let beforeSequence = lastSequence + 1;
      for (const event of telemetry(this, "route")) {
        if (event.type !== "route") continue;
        if (route && (event.providerId !== route.providerId || event.modelId !== route.modelId)) {
          epochs.push({ firstRoute, route, routeBoundary: firstRoute!.sequence - 1, beforeSequence });
          beforeSequence = firstRoute!.sequence;
          route = event;
        }
        route ??= event;
        firstRoute = event;
      }
      epochs.push({ firstRoute, route, routeBoundary: -1, beforeSequence });
      // Keep each changed route's small footprint separately. A new model's
      // initial estimate must not erase the earlier conversation display, while
      // the route boundary still prevents borrowing its capacity for new usage.
      const footprint = ({ firstRoute, route, routeBoundary, beforeSequence }: RouteEpoch) => {
        const lastContext = latest("context_usage", routeBoundary, beforeSequence);
        const context = lastContext && lastContext.sequence > routeBoundary ? lastContext : undefined;
        const measuredContext = context?.type === "context_usage" && context.context.source === "provider" ? context
          : latestMatching("context_usage", event => event.type === "context_usage" && event.context.source === "provider", routeBoundary, beforeSequence);
        const mainUsage = latestMatching("usage", event => event.type === "usage"
          && (event.usage.purpose === undefined || event.usage.purpose === "main")
          && Number.isFinite(event.usage.inputTokens) && event.usage.inputTokens > 0, routeBoundary, beforeSequence);
        const mainFinished = latestMatching("model_request_finished", event => event.type === "model_request_finished" && event.purpose === "main", routeBoundary, beforeSequence);
        const mainSucceeded = mainFinished?.type === "model_request_finished" && mainFinished.succeeded ? mainFinished
          : latestMatching("model_request_finished", event => event.type === "model_request_finished" && event.purpose === "main" && event.succeeded, routeBoundary, beforeSequence);
        const adjustments: AgentEvent[] = [];
        let hasCapacity = false, hasTokens = false, hasCommittedAdjustment = false;
        for (const event of telemetry(this, "context_adjusted", routeBoundary, beforeSequence)) {
          if (event.type !== "context_adjusted") continue;
          const { capacityTokens, afterTokens } = event.adjustment;
          const capacity: boolean = !hasCapacity && capacityTokens !== undefined && Number.isFinite(capacityTokens) && capacityTokens > 0;
          const tokens: boolean = !hasTokens && afterTokens !== undefined && Number.isFinite(afterTokens) && afterTokens >= 0;
          const committed: boolean = !hasCommittedAdjustment && isCommittedContextAdjustment(event.adjustment);
          if (capacity || tokens || committed) adjustments.push(event);
          hasCapacity ||= capacity;
          hasTokens ||= tokens;
          hasCommittedAdjustment ||= committed;
          if (hasCapacity && hasTokens && hasCommittedAdjustment) break;
        }
        const committedAdjustment = adjustments.find(event => event.type === "context_adjusted" && isCommittedContextAdjustment(event.adjustment));
        const resetSequence = Math.max(routeBoundary, measuredContext?.sequence ?? -1, mainUsage?.sequence ?? -1, committedAdjustment?.sequence ?? -1);
        const contexts = telemetry(this, "context_usage", routeBoundary, beforeSequence);
        const changes = telemetry(this, "context_adjusted", routeBoundary, beforeSequence);
        let nextContext: AgentEvent | undefined = contexts.next().value;
        let nextChange: AgentEvent | undefined = changes.next().value;
        let capacityAnchor: AgentEvent | undefined, peakEstimate: AgentEvent | undefined;
        let currentCapacity: number | undefined, peakTokens = -1;
        // Preserve the high estimate after the last trusted replacement. A later
        // resume estimate can otherwise hide an estimate-only provider's baseline.
        // Merge bounded telemetry pages backwards; only two anchors are returned.
        while (nextContext || nextChange) {
          let event: AgentEvent;
          if (nextContext && (!nextChange || nextContext.sequence > nextChange.sequence)) {
            event = nextContext;
            nextContext = contexts.next().value;
          } else {
            event = nextChange!;
            nextChange = changes.next().value;
          }
          const capacity = event.type === "context_usage" ? event.context.capacityTokens
            : event.type === "context_adjusted" ? event.adjustment.capacityTokens : undefined;
          const validCapacity = capacity !== undefined && Number.isFinite(capacity) && capacity > 0;
          if (validCapacity) {
            if (currentCapacity !== undefined && capacity !== currentCapacity) break;
            currentCapacity = capacity;
            capacityAnchor = event;
          }
          const tokens = event.type === "context_usage" && event.context.source === "estimate" ? event.context.usedTokens
            : event.type === "context_adjusted" ? event.adjustment.afterTokens : undefined;
          if (event.sequence > resetSequence && tokens !== undefined && Number.isFinite(tokens) && tokens > peakTokens) {
            peakEstimate = event;
            peakTokens = tokens;
          }
          if (event.sequence <= resetSequence && validCapacity) break;
        }
        return [firstRoute, route, context, measuredContext, mainUsage, mainFinished, mainSucceeded, ...adjustments, capacityAnchor, peakEstimate];
      };
      const result = latest("result");
      const userRows = this.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND type IN ('steering_submitted','steering_delivered') ORDER BY sequence").all(row.id) as unknown as Array<EventRow & { sequence: number }>;
      const userEvents = userRows.map(event => this.decodeEvent(event.payload, row.id, event.sequence));
      const submittedMessages = new Set(userEvents.flatMap(event => event.type === "steering_submitted" ? [event.messageId] : []));
      const userBoundaries = userEvents.filter(event => event.type === "steering_submitted" || (event.type === "steering_delivered" && (!event.messageId || !submittedMessages.has(event.messageId))));
      const textRows = this.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND type='text_delta' AND sequence>? ORDER BY sequence").all(row.id, result?.sequence ?? -1) as unknown as Array<EventRow & { sequence: number }>;
      const deltas = textRows.map(event => this.decodeEvent(event.payload, row.id, event.sequence)).filter((event): event is Extract<AgentEvent, { type: "text_delta" }> => event.type === "text_delta");
      const textPreview: AgentEvent[] = [];
      let pendingDeltas: typeof deltas = [];
      const flushDeltas = () => {
        const lastDelta = pendingDeltas.at(-1);
        if (lastDelta) textPreview.push({ ...lastDelta, delta: pendingDeltas.map(event => event.delta).join("") });
        pendingDeltas = [];
      };
      // Keep human replies visible before hydration, and never aggregate text across them.
      for (const event of [...deltas, ...userBoundaries].sort((a, b) => a.sequence - b.sequence)) {
        if (event.type === "text_delta") pendingDeltas.push(event);
        else flushDeltas();
      }
      flushDeltas();
      const preview = [...epochs.reverse().flatMap(footprint), latest("status"),
        result, ...userEvents, ...textPreview]
        .filter((event): event is AgentEvent => Boolean(event));
      const events = [...new Map(preview.map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
      return { spec, status: row.status, events, view: { lastSequence, eventsComplete: lastSequence < 0 } };
    });
    const first = runs[0];
    return { session, runs, withdrawnEvents: this.withdrawnEvents(id), hasMore: rows.length > limit, ...(first ? { before: { createdAt: first.spec.createdAt, id: first.spec.id } } : {}) };
  }

  private visibleSession(id: string): SessionRecord | undefined {
    const session = this.get<SessionRecord>("sessions", id);
    if (!session || session.deletedAt) return;
    const project = this.get<ProjectRecord>("projects", projectId(session.workspacePath));
    return project && !project.deletedAt ? session : undefined;
  }

  listEventPage(runId: string, afterSequence = -1, limit = 100): RunEventPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid event page limit");
    const run = this.getRun(runId);
    if (!run || !this.visibleSession(run.spec.sessionId)) throw new Error("会话不存在或已删除");
    const rows = this.db.prepare("SELECT sequence,payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId, afterSequence, limit + 1) as unknown as Array<EventRow & { sequence: number }>;
    const events = rows.slice(0, limit).map(row => {
      const event = this.crypto.decryptJson<AgentEvent & { __outputRef?: string }>(row.payload, `event:${runId}:${row.sequence}`);
      if (event.type !== "tool_finished") return event;
      // No content-object lookup on the display path, including legacy inline outputs.
      const rest = { ...event };
      delete rest.__outputRef;
      return { ...rest, output: { deferred: true, runId, callId: event.callId } };
    });
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence, hasMore: rows.length > limit, status: run.status };
  }

  getOutputPage(runId: string, callId: string, offset = 0, limit = 16000): { text: string; nextOffset: number; hasMore: boolean } {
    const run = this.getRun(runId);
    if (!run || !this.visibleSession(run.spec.sessionId)) throw new Error("会话不存在或已删除");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64000) throw new Error("Invalid output page");
    // Validate visibility before cache lookup. Decode/format once across consecutive transport pages.
    const key = JSON.stringify([runId, callId]);
    let text = this.outputPages.get(key);
    if (text === undefined) {
      const event = this.getToolEvidence(runId, callId);
      if (event?.type !== "tool_finished") throw new Error("工具输出不存在");
      text = typeof event.output === "string" ? event.output : JSON.stringify(event.output, null, 2) ?? "";
      if (text.length <= 8_000_000) {
        while (this.outputPages.size && (this.outputCharacters + text.length > 8_000_000 || this.outputPages.size >= 16)) {
          const oldest = this.outputPages.keys().next().value!;
          this.outputCharacters -= this.outputPages.get(oldest)!.length; this.outputPages.delete(oldest);
        }
        this.outputPages.set(key, text); this.outputCharacters += text.length;
      }
    } else { this.outputPages.delete(key); this.outputPages.set(key, text); }
    return { text: text.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, text.length), hasMore: offset + limit < text.length };
  }

  deleteSession(id: string): SessionRecord {
    this.clearOutputPages();
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (this.runsForSession(id).some((run) => liveStatuses.has(run.status)))
      throw new Error("Cannot delete a Session with an active run");
    if (session.deletedAt) return session;
    const updated = {
      ...session,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.upsert("sessions", id, updated);
    return updated;
  }

  restoreSession(id: string): SessionRecord {
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (!session.deletedAt) return session;
    const { deletedAt: _deletedAt, ...rest } = session;
    const updated = { ...rest, updatedAt: new Date().toISOString() };
    this.upsert("sessions", id, updated);
    return updated;
  }

  deleteProject(id: string): ProjectRecord {
    this.clearOutputPages();
    const project = this.get<ProjectRecord>("projects", id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    const sessionIds = new Set(
      this.list<SessionRecord>("sessions")
        .filter(
          (session) =>
            normalizeWorkspace(session.workspacePath) ===
            normalizeWorkspace(project.workspacePath),
        )
        .map((session) => session.id),
    );
    if (
      this.allRuns().some(
        (run) =>
          sessionIds.has(run.spec.sessionId) && liveStatuses.has(run.status),
      )
    )
      throw new Error("Cannot delete a project with an active run");
    if (project.deletedAt) return project;
    const updated = {
      ...project,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.upsert("projects", id, updated);
    return updated;
  }

  restoreProject(id: string): ProjectRecord {
    const project = this.get<ProjectRecord>("projects", id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    if (!project.deletedAt) return project;
    const { deletedAt: _deletedAt, ...rest } = project;
    const updated = { ...rest, updatedAt: new Date().toISOString() };
    this.upsert("projects", id, updated);
    return updated;
  }

  purgeSession(id: string): { sessionId: string; runs: number } {
    this.clearOutputPages();
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (!session.deletedAt)
      throw new Error("Session must be deleted before permanent deletion");
    const runs = this.runsForSession(id, true);
    if (runs.some((run) => liveStatuses.has(run.status)))
      throw new Error("Cannot purge a Session with an active run");
    const runIds = new Set(runs.map((run) => run.spec.id));
    const tables: GenericTable[] = [
      "approvals",
      "plans",
      "checkpoints",
      "compactions",
      "verification_runs",
      "traces",
    ];
    const ids = new Map(
      tables.map((table) => [
        table,
        this.list<Record<string, unknown>>(table)
          .filter(
            (record) =>
              typeof record.runId === "string" && runIds.has(record.runId),
          )
          .map((record) => String(record.id)),
      ]),
    );
    this.flushEvents();
    const candidates = this.contentReferences(runIds);
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const runId of runIds) {
        this.db.prepare("DELETE FROM tool_evidence WHERE run_id=?").run(runId);
        this.db.prepare("DELETE FROM events WHERE run_id=?").run(runId);
      }
      for (const [table, recordIds] of ids)
        for (const recordId of recordIds)
          this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId);
      for (const runId of runIds)
        this.db.prepare("DELETE FROM runs WHERE id=?").run(runId);
      this.db.prepare("DELETE FROM withdrawn_runs WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM steering_withdrawals WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM withdrawn_message_events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      const retained = this.contentReferences();
      for (const contentId of candidates) {
        if (!retained.has(contentId)) this.db.prepare("DELETE FROM content_objects WHERE id=?").run(contentId);
      }
      this.db.exec("COMMIT");
      return { sessionId: id, runs: runs.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private allRuns(): Array<{ spec: RunSpec; status: RunStatus }> {
    const rows = this.db
      .prepare("SELECT id, status, payload FROM runs WHERE id NOT IN (SELECT run_id FROM withdrawn_runs) ORDER BY created_at, id")
      .all() as unknown as RunRow[];
    return rows.map((row) => ({
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    }));
  }

  private runsForSession(
    sessionId: string,
    includeWithdrawn = false,
  ): Array<{ spec: RunSpec; status: RunStatus }> {
    this.flushEvents();
    const rows = this.db
      .prepare(
        `SELECT id, status, payload FROM runs WHERE session_id=? ${includeWithdrawn ? "" : "AND id NOT IN (SELECT run_id FROM withdrawn_runs)"} ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as RunRow[];
    return rows.map((row) => ({
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    }));
  }

  appendEvent(event: AgentEvent): void {
    if (this.closed) throw new Error("Database is closed");
    if (event.type === "tool_finished") {
      const key = JSON.stringify([event.runId, event.callId]);
      this.outputCharacters -= this.outputPages.get(key)?.length ?? 0; this.outputPages.delete(key);
    }
    if (this.flushError) this.flushEvents();
    if (event.type === "text_delta") {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.pendingBytes + bytes > 4096) this.flushEvents();
      this.pendingEvents.push(structuredClone(event));
      this.pendingBytes += bytes;
      if (this.pendingBytes >= 4096) this.flushEvents();
      else if (!this.eventTimer)
        this.eventTimer = setTimeout(() => {
          this.eventTimer = undefined;
          try {
            this.flushEvents();
          } catch (error) {
            this.flushError = error;
          }
        }, 100);
      return;
    }
    this.flushEvents();
    this.writeEvent(event);
  }

  /** Flushes pending deltas atomically. A failed transaction retains the buffer for retry. */
  flushEvents(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    if (!this.pendingEvents.length) {
      this.flushError = undefined;
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of this.pendingEvents) this.writeEvent(event);
      this.db.exec("COMMIT");
      this.pendingEvents = [];
      this.pendingBytes = 0;
      this.flushError = undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.flushError = error;
      throw error;
    }
  }

  private writeEvent(event: AgentEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events (run_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.runId,
        event.sequence,
        event.type,
        this.crypto.encryptJson(
          event.type === "tool_finished"
            ? {
                ...event,
                output: undefined,
                __outputRef: this.storeContent(event.output),
              }
            : event,
          `event:${event.runId}:${event.sequence}`,
        ),
        event.at,
      );
    const callId = toolCallId(event);
    if (callId) this.rememberEvidence(event.runId, callId, event.sequence);
  }

  /**
   * Resolve the recorded evidence of one tool call without scanning the run's history: the index
   * points straight at the sequence, so a lookup reads and decrypts a single row.
   */
  getToolEvidence(runId: string, callId: string): AgentEvent | undefined {
    this.flushEvents();
    const pointed = this.evidenceAt(runId, callId);
    if (pointed) return pointed;
    // A database written before the index existed has no pointers yet: resolve them once for this
    // run (never for the whole history) and remember them for the next lookup.
    let matched: AgentEvent | undefined;
    const rows = this.db
      .prepare(
        "SELECT sequence, payload FROM events WHERE run_id=? AND type IN ('tool_started','tool_finished') ORDER BY sequence",
      )
      .all(runId) as unknown as Array<EventRow & { sequence: number }>;
    for (const row of rows) {
      const event = this.decodeEvent(row.payload, runId, row.sequence);
      const call = toolCallId(event);
      if (!call) continue;
      this.rememberEvidence(runId, call, row.sequence);
      if (event.type === "tool_finished" && call === callId) matched = event;
    }
    return matched;
  }

  private decodeEvent(
    payload: string,
    runId: string,
    sequence: number,
  ): AgentEvent {
    const event = this.crypto.decryptJson<
      AgentEvent & { __outputRef?: string }
    >(payload, `event:${runId}:${sequence}`);
    if (event.type === "tool_finished" && event.__outputRef) {
      const { __outputRef, ...rest } = event;
      return { ...rest, output: this.readContent(__outputRef) } as AgentEvent;
    }
    return event;
  }

  private rememberEvidence(
    runId: string,
    callId: string,
    sequence: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO tool_evidence (run_id, call_id, sequence) VALUES (?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET sequence=excluded.sequence",
      )
      .run(runId, callId, sequence);
  }

  private evidenceAt(runId: string, callId: string): AgentEvent | undefined {
    const pointer = this.db
      .prepare(
        "SELECT sequence FROM tool_evidence WHERE run_id=? AND call_id=?",
      )
      .get(runId, callId) as { sequence: number } | undefined;
    if (!pointer) return undefined;
    const row = this.db
      .prepare(
        "SELECT sequence, payload FROM events WHERE run_id=? AND sequence=?",
      )
      .get(runId, pointer.sequence) as
      (EventRow & { sequence: number }) | undefined;
    return row ? this.decodeEvent(row.payload, runId, row.sequence) : undefined;
  }

  listEvents(runId: string, afterSequence = -1): AgentEvent[] {
    this.flushEvents();
    const rows = this.db
      .prepare(
        "SELECT sequence, payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence",
      )
      .all(runId, afterSequence) as unknown as Array<
      EventRow & { sequence: number }
    >;
    return rows.map((row) =>
      this.decodeEvent(row.payload, runId, row.sequence),
    );
  }

  savePlan(plan: PlanSpec): void {
    this.upsert("plans", plan.id, plan);
  }

  getPlan(id: string): PlanSpec | undefined {
    return this.get<PlanSpec>("plans", id);
  }

  getPlanForRun(runId: string): PlanSpec | undefined {
    return this.list<PlanSpec>("plans")
      .filter((plan) => plan.runId === runId)
      .sort((left, right) => right.version - left.version)[0];
  }

  /** Working context, accepted compaction and its visible events commit together. */
  saveCheckpoint(checkpoint: RunCheckpoint, compaction?: CompactionRecord, events: AgentEvent[] = []): void {
    this.flushEvents();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (compaction) this.upsert("compactions", compaction.id, compaction);
      this.upsert("checkpoints", checkpoint.id, checkpoint);
      for (const event of events) this.writeEvent(event);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      // A failed save may have remembered transcript addresses for rows just rolled back.
      // Retrying the same message objects must create those encrypted rows again.
      this.contentAddresses = new WeakMap();
      throw error;
    }
  }

  listCheckpoints(runId: string, limit = 20): RunCheckpoint[] {
    if (!Number.isInteger(limit) || limit < 0)
      throw new Error("Invalid checkpoint limit");
    this.flushEvents();
    const rows = this.db
      .prepare(
        "SELECT id, payload FROM checkpoints WHERE run_id=? ORDER BY sequence DESC, id DESC LIMIT ?",
      )
      .all(runId, limit) as unknown as GenericRow[];
    return rows.map((row) => this.decode<RunCheckpoint>("checkpoints", row));
  }

  getLatestCheckpoint(runId: string): RunCheckpoint | undefined {
    return this.listCheckpoints(runId, 1)[0];
  }

  saveCompaction(record: CompactionRecord): void {
    this.upsert("compactions", record.id, record);
  }
  listCompactions(runId: string): CompactionRecord[] {
    return this.scoped<CompactionRecord>("compactions", runId);
  }
  saveVerificationRun(run: VerificationRun): void {
    this.upsert("verification_runs", run.id, run);
  }
  listVerificationRuns(runId: string): VerificationRun[] {
    return this.scoped<VerificationRun>("verification_runs", runId);
  }
  savePlugin(plugin: PluginRecord): void {
    this.upsert("plugins", plugin.manifest.id, plugin);
  }
  getPlugin(id: string): PluginRecord | undefined {
    return this.get<PluginRecord>("plugins", id);
  }
  listPlugins(): PluginRecord[] {
    return this.list<PluginRecord>("plugins");
  }
  saveMcpServer(config: McpServerConfig): void { this.upsert("mcp_servers", config.id, config); }
  getMcpServer(id: string): McpServerConfig | undefined { return this.get<McpServerConfig>("mcp_servers", id); }
  listMcpServers(): McpServerConfig[] { return this.list<McpServerConfig>("mcp_servers"); }
  deleteMcpServer(id: string): void { this.db.prepare("DELETE FROM mcp_servers WHERE id=?").run(id); }
  saveMcpAuth(id: string, value: unknown): void { this.upsert("mcp_auth", id, value); }
  getMcpAuth<T>(id: string): T | undefined { return this.get<T>("mcp_auth", id); }
  deleteMcpAuth(id: string): void { this.db.prepare("DELETE FROM mcp_auth WHERE id=?").run(id); }
  saveEvalResult(result: EvalResult): void {
    this.upsert("eval_results", result.id, result);
  }
  listEvalResults(): EvalResult[] {
    return this.list<EvalResult>("eval_results");
  }

  appendTrace(record: {
    id: string;
    runId?: string;
    type: string;
    at: string;
    attributes: Record<string, unknown>;
  }): void {
    this.upsert("traces", record.id, record);
  }

  queryTraces(
    filter: { runId?: string; type?: string; limit?: number } = {},
  ): Array<{
    id: string;
    runId?: string;
    type: string;
    at: string;
    attributes: Record<string, unknown>;
  }> {
    return this.list<{
      id: string;
      runId?: string;
      type: string;
      at: string;
      attributes: Record<string, unknown>;
    }>("traces")
      .filter(
        (record) =>
          (!filter.runId || record.runId === filter.runId) &&
          (!filter.type || record.type === filter.type),
      )
      .slice(0, filter.limit ?? 200);
  }

  saveApproval(approval: ApprovalRequest): void {
    this.upsert("approvals", approval.id, approval);
  }
  getApproval(id: string): ApprovalRequest | undefined {
    return this.get<ApprovalRequest>("approvals", id);
  }
  listApprovals(): ApprovalRequest[] {
    return this.list<ApprovalRequest>("approvals");
  }

  saveMemory(memory: MemoryRecord): void {
    this.flushEvents();
    this.db.exec("BEGIN TRANSACTION");
    try {
      this.upsert("memories", memory.id, memory);
      this.db
        .prepare("DELETE FROM memory_search WHERE memory_id=?")
        .run(memory.id);
      const terms = tokenize(memory.content)
        .map((term) => this.crypto.searchToken(term))
        .join(" ");
      this.db
        .prepare("INSERT INTO memory_search (memory_id, terms) VALUES (?, ?)")
        .run(memory.id, terms);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listMemories(scopeId?: string): MemoryRecord[] {
    const all = this.list<MemoryRecord>("memories");
    return scopeId ? all.filter((memory) => memory.scopeId === scopeId) : all;
  }

  deleteMemory(id: string): void {
    this.flushEvents();
    this.db.exec("BEGIN TRANSACTION");
    try {
      this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(id);
      this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  searchMemories(
    query: string,
    scopeIds: string[],
    limit = 8,
    selections?: MemoryScopeSelection[],
  ): MemoryRecord[] {
    if (!scopeIds.length || limit <= 0) return [];
    const terms = tokenize(query).map((term) => this.crypto.searchToken(term));
    const matches = new Map(
      (
        this.db
          .prepare("SELECT memory_id, terms FROM memory_search")
          .all() as Array<{ memory_id: string; terms: string }>
      ).map((row) => {
        const indexed = new Set(row.terms.split(" "));
        return [
          row.memory_id,
          terms.filter((term) => indexed.has(term)).length,
        ];
      }),
    );
    const now = Date.now();
    return this.listMemories()
      .filter(
        (item) =>
          item.status === "approved" &&
          scopeIds.includes(item.scopeId) &&
          (!selections ||
            selections.some(
              (scope) =>
                scope.scope === item.scope && scope.scopeId === item.scopeId,
            )) &&
          (!item.expiresAt || Date.parse(item.expiresAt) > now) &&
          (item.pinned || (matches.get(item.id) ?? 0) > 0),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (matches.get(b.id) ?? 0) - (matches.get(a.id) ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }

  saveSkill(skill: SkillManifest): void {
    this.upsert("skills", skill.key ?? skill.id, skill);
  }
  listSkills(): SkillManifest[] {
    const skills = this.list<SkillManifest>("skills");
    // Prefer the source-qualified record after an older id-only record is re-trusted.
    const byPath = new Map<string, SkillManifest>();
    for (const skill of skills.sort((a, b) => Number(Boolean(a.key)) - Number(Boolean(b.key)))) byPath.set(skill.sourcePath, skill);
    return [...byPath.values()];
  }
  saveTask(task: TaskSpec): void {
    this.upsert("tasks", task.id, task);
  }
  listTasks(): TaskSpec[] {
    return this.list<TaskSpec>("tasks");
  }
  saveAttachment(attachment: AttachmentRef): void {
    this.upsert("attachments", attachment.id, attachment);
  }
  getAttachment(id: string): AttachmentRef | undefined {
    return this.get<AttachmentRef>("attachments", id);
  }

  saveProjectTrust(workspacePath: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO project_trust (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
      )
      .run(
        workspacePath,
        this.crypto.encryptJson(value, `project_trust:${workspacePath}`),
        new Date().toISOString(),
      );
  }

  getProjectTrust<T>(workspacePath: string): T | undefined {
    this.flushEvents();
    const row = this.db
      .prepare("SELECT id, payload FROM project_trust WHERE id=?")
      .get(workspacePath) as GenericRow | undefined;
    return row
      ? this.crypto.decryptJson<T>(
          row.payload,
          `project_trust:${workspacePath}`,
        )
      : undefined;
  }

  /**
   * Content objects are addressed by the hash of their JSON, so storing the same object twice repeats
   * the stringify, the hash and the existence check. Consecutive checkpoint saves hand over the same
   * transcript array — a checkpoint written for a reason other than a new turn re-stores the very
   * same message objects — so remembering an object's address skips that work.
   *
   * Opt-in per call: it is only sound for values the caller owns and will not mutate, which is true
   * of the checkpoint transcript and not guaranteed for objects arriving on the event path.
   */
  private contentAddresses = new WeakMap<object, string>();

  private storeContent(value: unknown, remember = false): string {
    const cacheable = remember && typeof value === "object" && value !== null;
    if (cacheable) {
      const remembered = this.contentAddresses.get(value as object);
      if (remembered !== undefined) return remembered;
    }
    const id = this.crypto.contentAddress(JSON.stringify(value));
    if (!this.db.prepare("SELECT id FROM content_objects WHERE id=?").get(id))
      this.db
        .prepare("INSERT INTO content_objects (id,payload) VALUES (?,?)")
        .run(id, this.crypto.encryptJson(value, `content:${id}`));
    if (cacheable) this.contentAddresses.set(value as object, id);
    return id;
  }

  /** Metadata-only reachability for an explicit permanent-delete operation. */
  private contentReferences(runIds?: ReadonlySet<string>): Set<string> {
    const refs = new Set<string>();
    for (const row of this.db.prepare("SELECT id,run_id,payload FROM checkpoints").all()) {
      if (runIds && !runIds.has(String(row.run_id))) continue;
      const metadata = this.crypto.decryptJson<Record<string, unknown>>(String(row.payload), "checkpoints:" + row.id);
      if (metadata.__checkpointFormat === 3) for (const ref of Object.values(metadata.__refs as Record<string, string | string[]>)) {
        for (const id of Array.isArray(ref) ? ref : [ref]) refs.add(id);
      }
    }
    for (const row of this.db.prepare("SELECT run_id,sequence,payload FROM events WHERE type='tool_finished'").all()) {
      if (runIds && !runIds.has(String(row.run_id))) continue;
      const event = this.crypto.decryptJson<Record<string, unknown>>(String(row.payload), "event:" + row.run_id + ":" + row.sequence);
      if (typeof event.__outputRef === "string") refs.add(event.__outputRef);
    }
    return refs;
  }

  private readContent(id: string): unknown {
    const row = this.db
      .prepare("SELECT payload FROM content_objects WHERE id=?")
      .get(id);
    if (!row) throw new Error(`Missing checkpoint content: ${id}`);
    return this.crypto.decryptJson(String(row.payload), `content:${id}`);
  }

  private decode<T>(table: GenericTable, row: GenericRow): T {
    const value = this.crypto.decryptJson<Record<string, unknown>>(
      row.payload,
      `${table}:${row.id}`,
    );
    if (table === "checkpoints" && value.__checkpointFormat === 3) {
      const { __checkpointFormat: _format, __refs, ...rest } = value;
      const refs = __refs as Record<string, string | string[]>;
      for (const [key, ref] of Object.entries(refs))
        rest[key] = Array.isArray(ref)
          ? ref.map((id) => this.readContent(id))
          : this.readContent(ref);
      return rest as T;
    }
    return value as T;
  }

  private scoped<T>(
    table: "compactions" | "verification_runs",
    runId: string,
  ): T[] {
    this.flushEvents();
    return (
      this.db
        .prepare(
          `SELECT id,payload FROM ${table} WHERE run_id=? ORDER BY updated_at DESC`,
        )
        .all(runId) as unknown as GenericRow[]
    ).map((row) => this.decode<T>(table, row));
  }

  private upsert(table: GenericTable, id: string, value: unknown): void {
    this.flushEvents();
    const original = value as Record<string, unknown>;
    if (table === "sessions" || table === "projects") {
      this.db.prepare(`INSERT INTO ${table}(id,payload,updated_at,sort_at,deleted,project_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,sort_at=excluded.sort_at,deleted=excluded.deleted,project_id=excluded.project_id`)
        .run(id, this.crypto.encryptJson(value, `${table}:${id}`), new Date().toISOString(), original.updatedAt, Number(Boolean(original.deletedAt)), table === "sessions" ? projectId(String(original.workspacePath)) : id);
      return;
    }
    if (table === "checkpoints") {
      const stored = { ...original },
        refs: Record<string, string | string[]> = {};
      if (Array.isArray(stored.transcript)) {
        refs.transcript = stored.transcript.map((message) =>
          this.storeContent(message, true),
        );
        delete stored.transcript;
      }
      for (const key of ["workflow", "context"])
        if (stored[key] !== undefined) {
          refs[key] = this.storeContent(stored[key]);
          delete stored[key];
        }
      value = { ...stored, __checkpointFormat: 3, __refs: refs };
    }
    if (["checkpoints", "compactions", "verification_runs"].includes(table)) {
      this.db
        .prepare(
          `INSERT INTO ${table} (id,payload,updated_at,run_id,sequence) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,run_id=excluded.run_id,sequence=excluded.sequence`,
        )
        .run(
          id,
          this.crypto.encryptJson(value, `${table}:${id}`),
          new Date().toISOString(),
          original.runId,
          original.sequence ?? 0,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        this.crypto.encryptJson(value, `${table}:${id}`),
        new Date().toISOString(),
      );
  }

  private get<T>(table: GenericTable, id: string): T | undefined {
    this.flushEvents();
    const row = this.db
      .prepare(`SELECT id, payload FROM ${table} WHERE id=?`)
      .get(id) as GenericRow | undefined;
    return row ? this.decode<T>(table, row) : undefined;
  }

  private list<T>(table: GenericTable): T[] {
    this.flushEvents();
    const rows = this.db
      .prepare(`SELECT id, payload FROM ${table} ORDER BY updated_at DESC`)
      .all() as unknown as GenericRow[];
    return rows.map((row) => this.decode<T>(table, row));
  }

  /** Keyset iteration retains only one encrypted row and decoded checkpoint at a time. */
  private *migrationRows(table: "runs" | "checkpoints" | "compactions" | "verification_runs"): Generator<GenericRow> {
    let row = this.db.prepare(`SELECT id,payload FROM ${table} ORDER BY id LIMIT 1`).get() as GenericRow | undefined;
    while (row) {
      yield row;
      row = this.db.prepare(`SELECT id,payload FROM ${table} WHERE id>? ORDER BY id LIMIT 1`).get(row.id) as GenericRow | undefined;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS withdrawn_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, withdrawn_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS withdrawn_runs_session ON withdrawn_runs(session_id);
      CREATE TABLE IF NOT EXISTS steering_withdrawals (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steering_withdrawals_run ON steering_withdrawals(run_id);
      CREATE INDEX IF NOT EXISTS steering_withdrawals_session ON steering_withdrawals(session_id);
      CREATE TABLE IF NOT EXISTS withdrawn_message_events (run_id TEXT NOT NULL,sequence INTEGER NOT NULL,session_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
      CREATE INDEX IF NOT EXISTS withdrawn_message_events_session ON withdrawn_message_events(session_id);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence), FOREIGN KEY (run_id) REFERENCES runs(id));
      CREATE INDEX IF NOT EXISTS events_run_type ON events(run_id, type);
      CREATE TABLE IF NOT EXISTS tool_evidence (run_id TEXT NOT NULL, call_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (run_id, call_id));
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_search (memory_id TEXT PRIMARY KEY, terms TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_trust (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compactions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_auth (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS eval_results (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS content_objects (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (Number(version) < 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const runColumns = this.db.prepare("PRAGMA table_info(runs)").all();
        if (!runColumns.some((row) => row.name === "session_id"))
          this.db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
        for (const row of this.migrationRows("runs")) {
          const run = this.crypto.decryptJson<RunSpec>(row.payload, "run:" + row.id);
          this.db.prepare("UPDATE runs SET session_id=? WHERE id=?").run(run.sessionId, row.id);
        }
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, created_at, id)",
        );
        const latest = new Map<string, number>();
        const total = Number(this.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()?.n ?? 0);
        let completed = 0;
        for (const table of [
          "checkpoints",
          "compactions",
          "verification_runs",
        ] as const) {
          const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
          if (!columns.some((row) => row.name === "run_id"))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN run_id TEXT`);
          if (!columns.some((row) => row.name === "sequence"))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN sequence INTEGER`);
          for (const row of this.migrationRows(table)) {
            const record = this.decode<Record<string, unknown>>(table, row);
            this.upsert(table, row.id, record);
            if (table === "checkpoints") {
              const restored = this.get<RunCheckpoint>(table, row.id);
              if (!isDeepStrictEqual(restored, record)) throw new Error("Checkpoint migration validation failed: " + row.id);
              const runId = String(record.runId), sequence = Number(record.sequence);
              latest.set(runId, Math.max(latest.get(runId) ?? -1, sequence));
              this.onProgress?.({ stage: "storage_migrate", completed: ++completed, total });
            }
          }
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id, sequence DESC)`,
          );
        }
        for (const [runId, sequence] of latest) {
          if (this.getLatestCheckpoint(runId)?.sequence !== sequence) throw new Error("Latest checkpoint migration validation failed: " + runId);
        }
        this.db.exec("PRAGMA user_version=3; COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    // Metadata only: titles, workspace paths and message bodies remain encrypted.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sessions", "projects"] as const) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some(column => column.name === "sort_at")) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN sort_at TEXT; ALTER TABLE ${table} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0; ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
          const rows = this.db.prepare(`SELECT id,payload FROM ${table}`).all() as unknown as GenericRow[];
          for (const row of rows) {
            const record = this.decode<SessionRecord | ProjectRecord>(table, row);
            this.db.prepare(`UPDATE ${table} SET sort_at=?,deleted=?,project_id=? WHERE id=?`).run(record.updatedAt, Number(Boolean(record.deletedAt)), table === "sessions" ? projectId(record.workspacePath) : row.id, row.id);
          }
        }
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS sessions_page ON sessions(deleted,sort_at DESC,id DESC); CREATE INDEX IF NOT EXISTS events_display ON events(run_id,type,sequence DESC); COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.backfillSessions();
  }

  private backfillSessions(): void {
    const existing = new Set(
      this.list<SessionRecord>("sessions").map((session) => session.id),
    );
    const grouped = new Map<
      string,
      Array<{ spec: RunSpec; status: RunStatus }>
    >();
    const orphaned = this.db.prepare("SELECT r.id, r.status, r.payload FROM runs r LEFT JOIN sessions s ON s.id=r.session_id WHERE s.id IS NULL ORDER BY r.created_at, r.id").all() as unknown as RunRow[];
    for (const row of orphaned) {
      const run = { spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status };
      grouped.set(run.spec.sessionId, [
        ...(grouped.get(run.spec.sessionId) ?? []),
        run,
      ]);
    }
    for (const [sessionId, runs] of grouped) {
      const first = runs[0]!,
        last = runs.at(-1)!;
      this.ensureProject(last.spec.workspacePath, first.spec.createdAt);
      if (!existing.has(sessionId))
        this.upsert(
          "sessions",
          sessionId,
          SessionRecordSchema.parse({
            id: sessionId,
            workspacePath: last.spec.workspacePath,
            profileId: last.spec.profileId,
            title: first.spec.request.slice(0, 300) || "新会话",
            createdAt: first.spec.createdAt,
            updatedAt: last.spec.createdAt,
          }),
        );
    }
  }
}

function normalizeWorkspace(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
function projectId(workspacePath: string): string {
  return `project_${createHash("sha256").update(normalizeWorkspace(workspacePath)).digest("hex").slice(0, 24)}`;
}

function tokenize(value: string): string[] {
  return [
    ...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []),
  ].slice(0, 256);
}
