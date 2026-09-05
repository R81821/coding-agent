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
  RunSpec,
  RunStatus,
  SkillManifest,
  TaskSpec,
  VerificationRun
} from "@harness/protocol";
import { ProfileSchema } from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";
import { SQLiteFile } from "./sqlite.js";

interface RunRow { id: string; status: RunStatus; payload: string }
interface EventRow { payload: string }
interface GenericRow { id: string; payload: string }
type GenericTable = "profiles" | "approvals" | "memories" | "skills" | "tasks" | "attachments" | "plans" | "checkpoints" | "compactions" | "verification_runs" | "plugins" | "eval_results" | "traces";

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
  }

  getRun(runId: string): { spec: RunSpec; status: RunStatus } | undefined {
    const row = this.db.prepare("SELECT id, status, payload FROM runs WHERE id=?").get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return { spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status };
  }

  listInterruptedRuns(): Array<{ spec: RunSpec; status: RunStatus }> {
    const rows = this.db.prepare("SELECT id, status, payload FROM runs WHERE status IN ('planning','running','waiting_approval','verifying')").all() as unknown as RunRow[];
    return rows.map((row) => ({ spec: this.crypto.decryptJson<RunSpec>(row.payload, `run:${row.id}`), status: row.status }));
  }

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
    `);
  }
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 256);
}
