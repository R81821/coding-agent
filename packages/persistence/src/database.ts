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
  VerificationRun
} from "@harness/protocol";
import { ProfileSchema, ProjectRecordSchema, SessionRecordSchema } from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";
import { SQLiteFile } from "./sqlite.js";

interface RunRow { id: string; status: RunStatus; payload: string }
interface EventRow { payload: string }
interface GenericRow { id: string; payload: string }
type GenericTable = "profiles" | "approvals" | "memories" | "skills" | "tasks" | "attachments" | "plans" | "checkpoints" | "compactions" | "verification_runs" | "plugins" | "eval_results" | "traces" | "sessions" | "projects";
const liveStatuses = new Set<RunStatus>(["queued", "planning", "running", "waiting_approval", "verifying"]);

export class HarnessDatabase {
  private readonly db: SQLiteFile;

  private constructor(database: SQLiteFile, private readonly crypto: VaultCrypto) {
    this.db = database;
    this.migrate();
  }

  static async open(path: string, crypto: VaultCrypto): Promise<HarnessDatabase> {
    await mkdir(dirname(path), { recursive: true });
    return new HarnessDatabase(await SQLiteFile.open(path), crypto);
  }

  close(): void {
    this.db.close();
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
    this.db.prepare("INSERT INTO runs (id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at")
      .run(spec.id, status, this.crypto.encryptJson(spec, `run:${spec.id}`), spec.createdAt, now);
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    this.db.prepare("UPDATE runs SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), runId);
    const run = this.getRun(runId);
    if (run && this.get<SessionRecord>("sessions", run.spec.sessionId)) this.touchSession(run.spec.sessionId, { updatedAt: new Date().toISOString() });
  }

  getRun(runId: string): { spec: RunSpec; status: RunStatus } | undefined {
    const row = this.db.prepare("SELECT id, status, payload FROM runs WHERE id=?").get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return { spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status };
  }

  listRunHistory(limit = 50, offset = 0): RunHistoryPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid history pagination");
    const rows = this.db.prepare("SELECT id, status, payload FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(limit + 1, offset) as unknown as RunRow[];
    return {
      items: rows.slice(0, limit).map((row) => {
        const spec = this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`);
        return { id: spec.id, sessionId: spec.sessionId, request: spec.request, workspacePath: spec.workspacePath, profileId: spec.profileId, createdAt: spec.createdAt, status: row.status };
      }),
      hasMore: rows.length > limit,
    };
  }

  listInterruptedRuns(): Array<{ spec: RunSpec; status: RunStatus }> {
    const rows = this.db.prepare("SELECT id, status, payload FROM runs WHERE status IN ('planning','running','waiting_approval','verifying')").all() as unknown as RunRow[];
    return rows.map((row) => ({ spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status }));
  }

  ensureProject(workspacePath: string, at = new Date().toISOString()): ProjectRecord {
    const id = projectId(workspacePath);
    const current = this.get<ProjectRecord>("projects", id);
    if (current) return current;
    const project = ProjectRecordSchema.parse({ id, workspacePath, createdAt: at, updatedAt: at });
    this.upsert("projects", id, project);
    return project;
  }

  listProjects(deleted = false): ProjectRecord[] {
    return this.list<ProjectRecord>("projects").map(record => ProjectRecordSchema.parse(record)).filter(record => Boolean(record.deletedAt) === deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  }

  createSession(input: SessionRecord): SessionRecord {
    const session = SessionRecordSchema.parse(input);
    if (this.get<SessionRecord>("sessions", session.id)) throw new Error(`Session already exists: ${session.id}`);
    const project = this.ensureProject(session.workspacePath, session.createdAt);
    if (project.deletedAt) throw new Error("Cannot create a Session in a deleted project");
    this.upsert("sessions", session.id, session);
    return session;
  }

  touchSession(id: string, patch: Partial<Pick<SessionRecord, "title" | "profileId" | "updatedAt">>): SessionRecord {
    const current = this.get<SessionRecord>("sessions", id);
    if (!current) throw new Error(`Unknown Session: ${id}`);
    const updated = SessionRecordSchema.parse({ ...current, ...patch });
    this.upsert("sessions", id, updated);
    const project = this.ensureProject(updated.workspacePath, updated.createdAt);
    if (!project.deletedAt) this.upsert("projects", project.id, { ...project, workspacePath: updated.workspacePath, updatedAt: updated.updatedAt });
    return updated;
  }

  listSessions(input: { deleted?: boolean; limit?: number; offset?: number } = {}): SessionPage {
    const deleted = input.deleted ?? false, limit = input.limit ?? 50, offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid Session pagination");
    const visibleProjects = new Set(this.listProjects(false).map(project => project.id));
    const records = this.list<SessionRecord>("sessions").map(record => SessionRecordSchema.parse(record)).filter(record => Boolean(record.deletedAt) === deleted).filter(record => deleted || visibleProjects.has(projectId(record.workspacePath))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { items: records.slice(offset, offset + limit).map(session => { const runs = this.runsForSession(session.id), latest = runs.at(-1); return { ...session, runCount: runs.length, ...(latest ? { latestRunId: latest.spec.id, latestStatus: latest.status } : {}) }; }), hasMore: records.length > offset + limit };
  }

  getSessionDetail(id: string): SessionDetail | undefined {
    const session = this.get<SessionRecord>("sessions", id);
    return session ? { session: SessionRecordSchema.parse(session), runs: this.runsForSession(id).map(run => ({ ...run, events: this.listEvents(run.spec.id) })) } : undefined;
  }

  deleteSession(id: string): SessionRecord {
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (this.runsForSession(id).some(run => liveStatuses.has(run.status))) throw new Error("Cannot delete a Session with an active run");
    if (session.deletedAt) return session;
    const updated = { ...session, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.upsert("sessions", id, updated); return updated;
  }

  restoreSession(id: string): SessionRecord {
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (!session.deletedAt) return session;
    const { deletedAt: _deletedAt, ...rest } = session;
    const updated = { ...rest, updatedAt: new Date().toISOString() };
    this.upsert("sessions", id, updated); return updated;
  }

  deleteProject(id: string): ProjectRecord {
    const project = this.get<ProjectRecord>("projects", id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    const sessionIds = new Set(this.list<SessionRecord>("sessions").filter(session => normalizeWorkspace(session.workspacePath) === normalizeWorkspace(project.workspacePath)).map(session => session.id));
    if (this.allRuns().some(run => sessionIds.has(run.spec.sessionId) && liveStatuses.has(run.status))) throw new Error("Cannot delete a project with an active run");
    if (project.deletedAt) return project;
    const updated = { ...project, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.upsert("projects", id, updated); return updated;
  }

  restoreProject(id: string): ProjectRecord {
    const project = this.get<ProjectRecord>("projects", id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    if (!project.deletedAt) return project;
    const { deletedAt: _deletedAt, ...rest } = project;
    const updated = { ...rest, updatedAt: new Date().toISOString() };
    this.upsert("projects", id, updated); return updated;
  }

  purgeSession(id: string): { sessionId: string; runs: number } {
    const session = this.get<SessionRecord>("sessions", id);
    if (!session) throw new Error(`Unknown Session: ${id}`);
    if (!session.deletedAt) throw new Error("Session must be deleted before permanent deletion");
    const runs = this.runsForSession(id);
    if (runs.some(run => liveStatuses.has(run.status))) throw new Error("Cannot purge a Session with an active run");
    const runIds = new Set(runs.map(run => run.spec.id));
    const tables: GenericTable[] = ["approvals", "plans", "checkpoints", "compactions", "verification_runs", "traces"];
    const ids = new Map(tables.map(table => [table, this.list<Record<string, unknown>>(table).filter(record => typeof record.runId === "string" && runIds.has(record.runId)).map(record => String(record.id))]));
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const runId of runIds) this.db.prepare("DELETE FROM events WHERE run_id=?").run(runId);
      for (const [table, recordIds] of ids) for (const recordId of recordIds) this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId);
      for (const runId of runIds) this.db.prepare("DELETE FROM runs WHERE id=?").run(runId);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.db.exec("COMMIT"); return { sessionId: id, runs: runs.length };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private allRuns(): Array<{ spec: RunSpec; status: RunStatus }> {
    const rows = this.db.prepare("SELECT id, status, payload FROM runs ORDER BY created_at, id").all() as unknown as RunRow[];
    return rows.map(row => ({ spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status }));
  }

  private runsForSession(sessionId: string): Array<{ spec: RunSpec; status: RunStatus }> { return this.allRuns().filter(run => run.spec.sessionId === sessionId); }

  appendEvent(event: AgentEvent): void {
    this.db.prepare("INSERT OR IGNORE INTO events (run_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.runId, event.sequence, event.type, this.crypto.encryptJson(event, `event:${event.runId}:${event.sequence}`), event.at);
  }

  listEvents(runId: string, afterSequence = -1): AgentEvent[] {
    const rows = this.db.prepare("SELECT sequence, payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, afterSequence) as unknown as Array<EventRow & { sequence: number }>;
    return rows.map((row) => this.crypto.decryptJson<AgentEvent>(row.payload, `event:${runId}:${row.sequence}`));
  }

  savePlan(plan: PlanSpec): void { this.upsert("plans", plan.id, plan); }

  getPlan(id: string): PlanSpec | undefined { return this.get<PlanSpec>("plans", id); }

  getPlanForRun(runId: string): PlanSpec | undefined {
    return this.list<PlanSpec>("plans")
      .filter((plan) => plan.runId === runId)
      .sort((left, right) => right.version - left.version)[0];
  }

  saveCheckpoint(checkpoint: RunCheckpoint): void { this.upsert("checkpoints", checkpoint.id, checkpoint); }

  listCheckpoints(runId: string, limit = 20): RunCheckpoint[] {
    return this.list<RunCheckpoint>("checkpoints")
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit);
  }

  getLatestCheckpoint(runId: string): RunCheckpoint | undefined {
    return this.listCheckpoints(runId, 1)[0];
  }

  saveCompaction(record: CompactionRecord): void { this.upsert("compactions", record.id, record); }
  listCompactions(runId: string): CompactionRecord[] { return this.list<CompactionRecord>("compactions").filter((record) => record.runId === runId); }
  saveVerificationRun(run: VerificationRun): void { this.upsert("verification_runs", run.id, run); }
  listVerificationRuns(runId: string): VerificationRun[] { return this.list<VerificationRun>("verification_runs").filter((run) => run.runId === runId); }
  savePlugin(plugin: PluginRecord): void { this.upsert("plugins", plugin.manifest.id, plugin); }
  getPlugin(id: string): PluginRecord | undefined { return this.get<PluginRecord>("plugins", id); }
  listPlugins(): PluginRecord[] { return this.list<PluginRecord>("plugins"); }
  saveEvalResult(result: EvalResult): void { this.upsert("eval_results", result.id, result); }
  listEvalResults(): EvalResult[] { return this.list<EvalResult>("eval_results"); }

  appendTrace(record: { id: string; runId?: string; type: string; at: string; attributes: Record<string, unknown> }): void {
    this.upsert("traces", record.id, record);
  }

  queryTraces(filter: { runId?: string; type?: string; limit?: number } = {}): Array<{ id: string; runId?: string; type: string; at: string; attributes: Record<string, unknown> }> {
    return this.list<{ id: string; runId?: string; type: string; at: string; attributes: Record<string, unknown> }>("traces")
      .filter((record) => (!filter.runId || record.runId === filter.runId) && (!filter.type || record.type === filter.type))
      .slice(0, filter.limit ?? 200);
  }

  saveApproval(approval: ApprovalRequest): void { this.upsert("approvals", approval.id, approval); }
  getApproval(id: string): ApprovalRequest | undefined { return this.get<ApprovalRequest>("approvals", id); }
  listApprovals(): ApprovalRequest[] { return this.list<ApprovalRequest>("approvals"); }

  saveMemory(memory: MemoryRecord): void {
    this.db.exec("BEGIN TRANSACTION");
    try {
      this.upsert("memories", memory.id, memory);
      this.db.prepare("DELETE FROM memory_search WHERE memory_id=?").run(memory.id);
      const terms = tokenize(memory.content).map((term) => this.crypto.searchToken(term)).join(" ");
      this.db.prepare("INSERT INTO memory_search (memory_id, terms) VALUES (?, ?)").run(memory.id, terms);
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

  searchMemories(query: string, scopeIds: string[], limit = 8, selections?: MemoryScopeSelection[]): MemoryRecord[] {
    if (!scopeIds.length || limit <= 0) return [];
    const terms = tokenize(query).map((term) => this.crypto.searchToken(term));
    const matches = new Map((this.db.prepare("SELECT memory_id, terms FROM memory_search").all() as Array<{ memory_id: string; terms: string }>).map((row) => {
      const indexed = new Set(row.terms.split(" "));
      return [row.memory_id, terms.filter((term) => indexed.has(term)).length];
    }));
    const now = Date.now();
    return this.listMemories().filter((item) =>
      item.status === "approved" && scopeIds.includes(item.scopeId) &&
      (!selections || selections.some((scope) => scope.scope === item.scope && scope.scopeId === item.scopeId)) &&
      (!item.expiresAt || Date.parse(item.expiresAt) > now) &&
      (item.pinned || (matches.get(item.id) ?? 0) > 0)
    ).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (matches.get(b.id) ?? 0) - (matches.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  saveSkill(skill: SkillManifest): void { this.upsert("skills", skill.id, skill); }
  listSkills(): SkillManifest[] { return this.list<SkillManifest>("skills"); }
  saveTask(task: TaskSpec): void { this.upsert("tasks", task.id, task); }
  listTasks(): TaskSpec[] { return this.list<TaskSpec>("tasks"); }
  saveAttachment(attachment: AttachmentRef): void { this.upsert("attachments", attachment.id, attachment); }
  getAttachment(id: string): AttachmentRef | undefined { return this.get<AttachmentRef>("attachments", id); }

  saveProjectTrust(workspacePath: string, value: unknown): void {
    this.db.prepare("INSERT INTO project_trust (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at")
      .run(workspacePath, this.crypto.encryptJson(value, `project_trust:${workspacePath}`), new Date().toISOString());
  }

  getProjectTrust<T>(workspacePath: string): T | undefined {
    const row = this.db.prepare("SELECT id, payload FROM project_trust WHERE id=?").get(workspacePath) as GenericRow | undefined;
    return row ? this.crypto.decryptJson<T>(row.payload, `project_trust:${workspacePath}`) : undefined;
  }

  private upsert(table: GenericTable, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(id, this.crypto.encryptJson(value, `${table}:${id}`), new Date().toISOString());
  }

  private get<T>(table: GenericTable, id: string): T | undefined {
    const row = this.db.prepare(`SELECT id, payload FROM ${table} WHERE id=?`).get(id) as GenericRow | undefined;
    return row ? this.crypto.decryptJson<T>(row.payload, `${table}:${row.id}`) : undefined;
  }

  private list<T>(table: GenericTable): T[] {
    const rows = this.db.prepare(`SELECT id, payload FROM ${table} ORDER BY updated_at DESC`).all() as unknown as GenericRow[];
    return rows.map((row) => this.crypto.decryptJson<T>(row.payload, `${table}:${row.id}`));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence), FOREIGN KEY (run_id) REFERENCES runs(id));
      CREATE INDEX IF NOT EXISTS events_run_type ON events(run_id, type);
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
    this.backfillSessions();
  }

  private backfillSessions(): void {
    const existing = new Set(this.list<SessionRecord>("sessions").map(session => session.id));
    const grouped = new Map<string, Array<{ spec: RunSpec; status: RunStatus }>>();
    for (const run of this.allRuns()) grouped.set(run.spec.sessionId, [...(grouped.get(run.spec.sessionId) ?? []), run]);
    for (const [sessionId, runs] of grouped) {
      const first = runs[0]!, last = runs.at(-1)!;
      this.ensureProject(last.spec.workspacePath, first.spec.createdAt);
      if (!existing.has(sessionId)) this.upsert("sessions", sessionId, SessionRecordSchema.parse({ id: sessionId, workspacePath: last.spec.workspacePath, profileId: last.spec.profileId, title: first.spec.request.slice(0, 300) || "新会话", createdAt: first.spec.createdAt, updatedAt: last.spec.createdAt }));
    }
  }
}

function normalizeWorkspace(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase(); }
function projectId(workspacePath: string): string { return `project_${createHash("sha256").update(normalizeWorkspace(workspacePath)).digest("hex").slice(0, 24)}`; }

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 256);
}
