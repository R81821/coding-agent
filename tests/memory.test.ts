import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { MemoryService } from "@harness/extensions";
import { DaemonRequestSchema, type MemoryRecord } from "@harness/protocol";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

describe("memory management and recall", () => {
  let root: string;
  let vault: VaultCrypto;
  let database: HarnessDatabase;
  let memory: MemoryService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-memory-test-"));
    vault = await VaultCrypto.open(join(root, "keys.json"), "memory-test-password");
    database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    memory = new MemoryService(database);
  });
  afterEach(async () => { database?.close(); vault?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

  function record(id: string, patch: Partial<MemoryRecord> = {}) {
    const value: MemoryRecord = { id, content: "project testing policy", source: "run:fixture", scope: "project", scopeId: "project-a", status: "approved", confidence: .8, pinned: false, approvedBy: "desktop:user", createdAt: "2026-01-01T00:00:00.000Z", ...patch };
    database.saveMemory(value);
    return value;
  }

  it("edits invalidate approval and reindex; renewed approval and metadata survive reopening", async () => {
    record("one");
    const edited = memory.update("one", { content: "unique replacement", pinned: true }, "desktop:user");
    expect(edited).toMatchObject({ status: "candidate", pinned: true, source: "run:fixture", editedBy: "desktop:user" });
    expect(edited.approvedBy).toBeUndefined();
    expect(memory.retrieve("replacement", "s", "project-a", ["project"])).toEqual([]);
    memory.decide("one", true, "desktop:user");
    memory.update("one", { pinned: false }, "desktop:user");
    expect(memory.retrieve("testing", "s", "project-a", ["project"])).toEqual([]);
    expect(memory.retrieve("replacement", "s", "project-a", ["project"])).toHaveLength(1);
    database.close();
    database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    expect(database.listMemories()).toMatchObject([{ content: "unique replacement", status: "approved", editedBy: "desktop:user" }]);
  });

  it("excludes expired or unapproved pins and prioritizes eligible pins", () => {
    record("normal"); record("pinned", { pinned: true, content: "unrelated but fixed" });
    record("expired", { pinned: true, expiresAt: "2000-01-01T00:00:00.000Z" });
    record("candidate", { pinned: true, status: "candidate" });
    record("rejected", { pinned: true, status: "rejected" });
    record("legacy", { status: "expired", pinned: true });
    expect(memory.retrieve("policy", "s", "project-a", ["project"]).map(m => m.id)).toEqual(["pinned", "normal"]);
    expect(memory.retrieve("", "s", "project-a", ["project"]).map(m => m.id)).toEqual(["pinned"]);
    expect(memory.retrieve("policy", "s", "project-a", ["project"], 1).map(m => m.id)).toEqual(["pinned"]);
  });

  it("honors each Profile scope including none and rejects scope-ID collisions", () => {
    record("project"); record("session", { scope: "session", scopeId: "session-a" });
    record("global", { scope: "global", scopeId: "global" });
    record("other", { scopeId: "other-project" });
    record("collision", { scope: "global", scopeId: "project-a" });
    expect(memory.retrieve("policy", "session-a", "project-a", [])).toEqual([]);
    for (const scope of ["project", "session", "global"] as const) {
      expect(memory.retrieve("policy", "session-a", "project-a", [scope]).map(m => m.id)).toEqual([scope]);
    }
  });

  it("filters ineligible records before limiting recall", () => {
    for (let i = 0; i < 30; i++) record(`excluded-${i}`, { scopeId: "another-project" });
    record("allowed");
    expect(memory.retrieve("policy", "s", "project-a", ["project"], 1).map(m => m.id)).toEqual(["allowed"]);
  });

  it("manages expiry without auto-approving expired candidates", () => {
    record("one", { status: "candidate", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(() => memory.decide("one", true, "desktop:user")).toThrow("已过期");
    memory.update("one", { expiresAt: null }, "desktop:user");
    expect(database.listMemories()[0]?.status).toBe("candidate");
    memory.decide("one", true, "desktop:user");
    expect(memory.retrieve("policy", "s", "project-a", ["project"])).toHaveLength(1);
    memory.update("one", { expiresAt: "2000-01-01T00:00:00.000Z" }, "desktop:user");
    expect(memory.retrieve("policy", "s", "project-a", ["project"])).toEqual([]);
  });

  it("deletes data and index across reopen and exports only requested IDs", async () => {
    record("one"); record("two");
    expect(memory.export(["one"])).toMatchObject({ schemaVersion: 1, records: [{ id: "one", source: "run:fixture" }] });
    expect(memory.export([]).records).toEqual([]);
    memory.delete("one");
    expect(() => memory.export(["one"])).toThrow("已被删除");
    database.close(); database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    expect(database.listMemories().map(m => m.id)).toEqual(["two"]);
    expect(database.searchMemories("testing", ["project-a"]).map(m => m.id)).toEqual(["two"]);
  });

  it("rejects malformed updates and prevents renderer actor impersonation", () => {
    record("one");
    expect(() => memory.update("one", { content: "  " }, "user")).toThrow();
    expect(() => memory.update("one", { expiresAt: "not-a-date" }, "user")).toThrow();
    const request = { id: "r", method: "memory.update", params: { memoryId: "one", actor: "evil", patch: { content: "changed", status: "approved" } } };
    expect(DaemonRequestSchema.safeParse(request).success).toBe(false);
    for (const method of ["memory.decide", "memory.update"]) {
      expect(sanitizeRendererRequest(method, { actor: "evil" }).params).toMatchObject({ actor: "desktop:user" });
    }
    expect(sanitizeRendererRequest("profiles.memoryScopes", {}).method).toBe("profiles.memoryScopes");
  });
});
