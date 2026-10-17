import type { MemoryRecord, MemoryPatch, MemoryScopeSelection, MemoryExport, MemoryCreate } from "@harness/protocol";
import { MemoryCreateSchema, MemoryPatchSchema, newId, nowIso } from "@harness/protocol";

export type MemoryProposal = Pick<MemoryRecord, "content" | "source" | "scope" | "scopeId" | "confidence"> &
  Partial<Pick<MemoryRecord, "expiresAt" | "kind" | "key" | "evidence">>;
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const sameScope = (a: Pick<MemoryRecord, "scope" | "scopeId">, b: Pick<MemoryRecord, "scope" | "scopeId">) => a.scope === b.scope && a.scopeId === b.scopeId;

export interface MemoryRepository {
  saveMemory(memory: MemoryRecord): void;
  saveMemories(memories: MemoryRecord[]): void;
  listMemories(scopeId?: string): MemoryRecord[];
  searchMemories(query: string, scopeIds: string[], limit?: number, selections?: MemoryScopeSelection[]): MemoryRecord[];
  deleteMemory(id: string): void;
}

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  propose(input: MemoryProposal): MemoryRecord {
    const value = { ...input, scopeId: input.scope === "global" ? "global" : input.scopeId };
    const existing = this.repository.listMemories().filter(item => sameScope(item, value));
    const duplicate = existing.find(item => normalized(item.content) === normalized(value.content));
    if (duplicate) {
      // Repeated extraction must not revive rejected, expired or superseded knowledge.
      const merged = { ...duplicate, sources: [...new Set([...(duplicate.sources ?? [duplicate.source]), value.source])].slice(-16), lastSeenAt: nowIso() };
      this.repository.saveMemory(merged);
      return merged;
    }
    const record: MemoryRecord = {
      id: newId("memory"),
      content: input.content,
      source: input.source,
      scope: input.scope,
      scopeId: value.scopeId,
      confidence: input.confidence,
      status: "candidate",
      pinned: false,
      createdAt: nowIso(),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.key ? { key: normalized(input.key).slice(0, 120) } : {}),
      ...(input.evidence ? { evidence: input.evidence.slice(0, 8) } : {}),
      sources: [input.source],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
    };
    record.conflictIds = this.conflicts(record).map(item => item.id);
    this.repository.saveMemory(record);
    return record;
  }

  conflicts(memory: MemoryRecord, all = this.repository.listMemories()): MemoryRecord[] {
    if (!memory.key) return [];
    return all.filter(item => item.id !== memory.id && sameScope(item, memory) &&
      (item.status === "approved" || item.status === "candidate") && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) &&
      item.key && normalized(item.key) === normalized(memory.key!) && normalized(item.content) !== normalized(memory.content));
  }

  list(scopeId?: string): MemoryRecord[] {
    const all = this.repository.listMemories();
    return all.filter(item => scopeId === undefined || item.scopeId === scopeId).map(item => ({ ...item, conflictIds: this.conflicts(item, all).map(conflict => conflict.id) }));
  }

  create(input: MemoryCreate, actor: string): MemoryRecord {
    const value = MemoryCreateSchema.parse(input);
    const proposed = this.propose({ ...value, source: actor, confidence: 1 });
    if (proposed.status !== "candidate" || this.conflicts(proposed).length) return proposed;
    return this.decide(proposed.id, true, actor);
  }

  saveSessionSummary(sessionId: string, content: string, source: string): MemoryRecord {
    const record: MemoryRecord = {
      id: newId("summary"),
      content,
      source,
      kind: "summary",
      scope: "session",
      scopeId: sessionId,
      confidence: 1,
      status: "approved",
      pinned: false,
      approvedBy: "system:session-summary",
      createdAt: nowIso()
    };
    this.repository.saveMemory(record);
    return record;
  }

  decide(id: string, approved: boolean, actor: string, replaceConflicts = false): MemoryRecord {
    const memory = this.repository.listMemories().find((item) => item.id === id);
    if (!memory) throw new Error(`Unknown memory: ${id}`);
    if (memory.status !== "candidate") throw new Error(`Memory ${id} has already been decided`);
    if (approved && memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) throw new Error("记忆已过期，请先修改过期时间");
    const conflicts = approved ? this.conflicts(memory) : [];
    if (conflicts.length && !replaceConflicts) throw new Error("这条记忆与已有内容冲突，请选择替换旧记忆或修改后再保存");
    const updated: MemoryRecord = { ...memory, status: approved ? "approved" : "rejected", approvedBy: actor, updatedAt: nowIso(), conflictIds: [] };
    this.repository.saveMemories([...conflicts.map(item => ({ ...item, status: "superseded" as const, supersededBy: id, updatedAt: nowIso() })), updated]);
    return updated;
  }

  update(id: string, input: MemoryPatch, actor: string): MemoryRecord {
    const patch = MemoryPatchSchema.parse(input);
    const current = this.repository.listMemories().find((item) => item.id === id);
    if (!current) throw new Error(`Unknown memory: ${id}`);
    const updated = { ...current, updatedAt: nowIso(), editedBy: actor };
    if (patch.content !== undefined && patch.content !== current.content) {
      updated.content = patch.content;
      updated.status = "candidate";
      delete updated.approvedBy;
    }
    if (patch.scope !== undefined || patch.scopeId !== undefined || patch.kind !== undefined || patch.key !== undefined) {
      updated.scope = patch.scope ?? current.scope;
      updated.scopeId = updated.scope === "global" ? "global" : patch.scopeId ?? current.scopeId;
      if (updated.scope === "project" && (updated.scopeId === "global" || !updated.scopeId.trim())) throw new Error("项目记忆需要指定项目路径");
      if (patch.kind !== undefined) updated.kind = patch.kind;
      if (patch.key !== undefined) updated.key = normalized(patch.key).slice(0, 120);
      updated.status = "candidate";
      delete updated.approvedBy;
    }
    if (patch.pinned !== undefined) updated.pinned = patch.pinned;
    if (patch.expiresAt === null) delete updated.expiresAt;
    else if (patch.expiresAt !== undefined) updated.expiresAt = patch.expiresAt;
    // Explicitly expired legacy records must be reviewed again when renewed.
    if (current.status === "expired" && "expiresAt" in patch) updated.status = "candidate";
    updated.conflictIds = this.conflicts(updated).map(item => item.id);
    this.repository.saveMemory(updated);
    return updated;
  }

  delete(id: string): void {
    if (!this.repository.listMemories().some((item) => item.id === id)) throw new Error(`Unknown memory: ${id}`);
    this.repository.deleteMemory(id);
  }

  export(memoryIds: string[]): MemoryExport {
    const selected = new Set(memoryIds);
    const records = this.repository.listMemories().filter((record) => selected.has(record.id));
    if (records.length !== selected.size) throw new Error("部分记忆已被删除，请刷新后导出");
    return { schemaVersion: 1, exportedAt: nowIso(), records };
  }

  retrieve(query: string, sessionId: string, projectId: string, scopes: MemoryRecord["scope"][], limit = 8): MemoryRecord[] {
    const scopeIds = { session: sessionId, project: projectId, global: "global" };
    const selections = [...new Set(scopes)].map((scope) => ({ scope, scopeId: scopeIds[scope] }));
    if (!selections.length) return [];
    return this.repository.searchMemories(query, selections.map((item) => item.scopeId), limit, selections);
  }
}
