import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
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
  Profile,
  RunCheckpoint,
  RunHistoryPage,
  SessionDetail,
  SessionPage,
  SessionRecord,
  ProjectRecord,
  RunSpec,
  RunStatus,
  SkillManifest,
  TaskSpec,
  VerificationRun,
} from "@harness/protocol";
import {
  ProfileSchema,
  ProjectRecordSchema,
  SessionRecordSchema,
} from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";
import { SQLiteFile } from "./sqlite.js";

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

  private constructor(
    database: SQLiteFile,
    private readonly crypto: VaultCrypto,
  ) {
    this.db = database;
    this.migrate();
  }

  static async open(
    path: string,
    crypto: VaultCrypto,
  ): Promise<HarnessDatabase> {
    await mkdir(dirname(path), { recursive: true });
    const file = await SQLiteFile.open(path, (staged) => {
      const before = staged
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'",
        )
        .get();
      const originals = before
        ? staged
            .prepare("SELECT id, payload FROM checkpoints")
            .all()
            .map((row) =>
              crypto.decryptJson<RunCheckpoint>(
                String(row.payload),
                `checkpoints:${row.id}`,
              ),
            )
        : [];
      const converted = new HarnessDatabase(staged, crypto);
      const latest = new Map<string, RunCheckpoint>();
      for (const checkpoint of originals) {
        if (
          !latest.has(checkpoint.runId) ||
          latest.get(checkpoint.runId)!.sequence < checkpoint.sequence
        )
          latest.set(checkpoint.runId, checkpoint);
        const restored = converted.get<RunCheckpoint>(
          "checkpoints",
          checkpoint.id,
        );
        if (!isDeepStrictEqual(restored, checkpoint))
          throw new Error(
            `Checkpoint migration validation failed: ${checkpoint.id}`,
          );
      }
      for (const [runId, checkpoint] of latest)
        if (
          converted.getLatestCheckpoint(runId)?.sequence !== checkpoint.sequence
        )
          throw new Error(
            `Latest checkpoint migration validation failed: ${runId}`,
          );
    });
    return new HarnessDatabase(file, crypto);
  }

  close(): void {
    if (this.closed) return;
    this.flushEvents();
    this.db.close();
    this.closed = true;
  }

  saveProfile(profile: Profile): void {
    const normalized = ProfileSchema.parse(profile);
    this.upsert("profiles", normalized.id, normalized);
  }

  listProfiles(): Profile[] {
    return this.list<unknown>("profiles").map((stored) => {
      const normalized = ProfileSchema.parse(stored);
      if (
        !stored ||
        typeof stored !== "object" ||
        !("resiliencePolicy" in stored)
      ) {
        this.upsert("profiles", normalized.id, normalized);
      }
      return normalized;
    });
  }

  saveRun(spec: RunSpec, status: RunStatus = "queued"): void {
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
    const row = this.db
      .prepare("SELECT id, status, payload FROM runs WHERE id=?")
      .get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return {
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    };
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
        "SELECT id, status, payload FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
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
    patch: Partial<Pick<SessionRecord, "title" | "profileId" | "updatedAt">>,
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
    const visibleProjects = new Set(
      this.listProjects(false).map((project) => project.id),
    );
    const records = this.list<SessionRecord>("sessions")
      .map((record) => SessionRecordSchema.parse(record))
      .filter((record) => Boolean(record.deletedAt) === deleted)
      .filter(
        (record) =>
          deleted || visibleProjects.has(projectId(record.workspacePath)),
      )
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
    return {
      items: records.slice(offset, offset + limit).map((session) => {
        const runs = this.runsForSession(session.id),
          latest = runs.at(-1);
        return {
          ...session,
          runCount: runs.length,
          ...(latest
            ? { latestRunId: latest.spec.id, latestStatus: latest.status }
            : {}),
        };
      }),
      hasMore: records.length > offset + limit,
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
        }
      : undefined;
  }

  deleteSession(id: string): SessionRecord {
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
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (!session.deletedAt)
      throw new Error("Session must be deleted before permanent deletion");
    const runs = this.runsForSession(id);
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
      .prepare("SELECT id, status, payload FROM runs ORDER BY created_at, id")
      .all() as unknown as RunRow[];
    return rows.map((row) => ({
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    }));
  }

  private runsForSession(
    sessionId: string,
  ): Array<{ spec: RunSpec; status: RunStatus }> {
    this.flushEvents();
    const rows = this.db
      .prepare(
        "SELECT id, status, payload FROM runs WHERE session_id=? ORDER BY created_at, id",
      )
      .all(sessionId) as unknown as RunRow[];
    return rows.map((row) => ({
      spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`),
      status: row.status,
    }));
  }

  appendEvent(event: AgentEvent): void {
    if (this.closed) throw new Error("Database is closed");
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

  saveCheckpoint(checkpoint: RunCheckpoint): void {
    this.flushEvents();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsert("checkpoints", checkpoint.id, checkpoint);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
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
    this.upsert("skills", skill.id, skill);
  }
  listSkills(): SkillManifest[] {
    return this.list<SkillManifest>("skills");
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

  private storeContent(value: unknown): string {
    const id = this.crypto.contentAddress(JSON.stringify(value));
    if (!this.db.prepare("SELECT id FROM content_objects WHERE id=?").get(id))
      this.db
        .prepare("INSERT INTO content_objects (id,payload) VALUES (?,?)")
        .run(id, this.crypto.encryptJson(value, `content:${id}`));
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
    if (table === "checkpoints") {
      const stored = { ...original },
        refs: Record<string, string | string[]> = {};
      if (Array.isArray(stored.transcript)) {
        refs.transcript = stored.transcript.map((message) =>
          this.storeContent(message),
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
        for (const run of this.allRuns())
          this.db
            .prepare("UPDATE runs SET session_id=? WHERE id=?")
            .run(run.spec.sessionId, run.spec.id);
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, created_at, id)",
        );
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
          for (const record of this.list<Record<string, unknown>>(table))
            this.upsert(table, String(record.id), record);
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id, sequence DESC)`,
          );
        }
        this.db.exec("PRAGMA user_version=3; COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
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
