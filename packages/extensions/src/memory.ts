import type { MemoryRecord, MemoryPatch, MemoryScopeSelection, MemoryExport } from "@harness/protocol";
import { MemoryPatchSchema, newId, nowIso } from "@harness/protocol";

export interface MemoryRepository {
  saveMemory(memory: MemoryRecord): void;
  listMemories(scopeId?: string): MemoryRecord[];
  searchMemories(query: string, scopeIds: string[], limit?: number, selections?: MemoryScopeSelection[]): MemoryRecord[];
  deleteMemory(id: string): void;
}

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  propose(input: Pick<MemoryRecord, "content" | "source" | "scope" | "scopeId" | "confidence"> & { expiresAt?: string }): MemoryRecord {
    const record: MemoryRecord = {
      id: newId("memory"),
      content: input.content,
      source: input.source,
      scope: input.scope,
      scopeId: input.scopeId,
      confidence: input.confidence,
      status: "candidate",
      pinned: false,
      createdAt: nowIso(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
    };
    this.repository.saveMemory(record);
    return record;
  }

  saveSessionSummary(sessionId: string, content: string, source: string): MemoryRecord {
    const record: MemoryRecord = {
      id: newId("summary"),
      content,
      source,
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

  decide(id: string, approved: boolean, actor: string): MemoryRecord {
    const memory = this.repository.listMemories().find((item) => item.id === id);
    if (!memory) throw new Error(`Unknown memory: ${id}`);
    if (memory.status !== "candidate") throw new Error(`Memory ${id} has already been decided`);
    if (approved && memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) throw new Error("记忆已过期，请先修改过期时间");
    const updated: MemoryRecord = { ...memory, status: approved ? "approved" : "rejected", approvedBy: actor };
    this.repository.saveMemory(updated);
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
    if (patch.pinned !== undefined) updated.pinned = patch.pinned;
    if (patch.expiresAt === null) delete updated.expiresAt;
    else if (patch.expiresAt !== undefined) updated.expiresAt = patch.expiresAt;
    // Explicitly expired legacy records must be reviewed again when renewed.
    if (current.status === "expired" && "expiresAt" in patch) updated.status = "candidate";
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
