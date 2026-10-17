import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { MemoryService } from "@harness/extensions";
import { ProjectTrustService } from "@harness/core";
import { ProjectMemoryService } from "../packages/core/src/project-memory.js";

describe("reviewed project knowledge publication", () => {
  let root: string, vault: VaultCrypto, database: HarnessDatabase, memory: MemoryService, trust: ProjectTrustService, publication: ProjectMemoryService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-memory-"));
    vault = await VaultCrypto.open(join(root, "keys.json"), "test-password");
    database = await HarnessDatabase.open(join(root, "store.sqlite"), vault);
    memory = new MemoryService(database); trust = new ProjectTrustService(database); publication = new ProjectMemoryService(memory, trust);
  });
  afterEach(async () => { vi.restoreAllMocks(); database?.close(); vault?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });
  function convention() { return memory.create({ content: "界面优先使用 shadcn 组件。", key: "ui.library", kind: "convention", scope: "project", scopeId: root }, "desktop:user"); }

  it("preserves handwritten instructions, separates facts, trusts exact reviewed content and is idempotent", async () => {
    await writeFile(join(root, "AGENTS.md"), "# 手写规则\n保留这段内容。\n");
    const rule = convention();
    const fact = memory.create({ content: "选择 SQLite 以支持离线工作。", key: "database", kind: "decision", scope: "project", scopeId: root }, "user");
    const preview = await publication.preview(root, [rule.id, fact.id]);
    expect(preview.files[0]?.before).toContain("手写规则");
    expect(await trust.loadInstructions(root)).toBeUndefined();
    await publication.publish(root, preview.memoryIds, preview.token);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("保留这段内容。"); expect(agents).toContain(rule.content); expect(agents).not.toContain(fact.content);
    expect(await readFile(join(root, "docs/agent-knowledge.md"), "utf8")).toContain(fact.content);
    expect(await trust.loadInstructions(root)).toContain(rule.content);
    const again = await publication.preview(root, [rule.id, fact.id]);
    expect(again.files.every(file => file.before === file.after)).toBe(true);
    await publication.publish(root, again.memoryIds, again.token);
    expect((await readFile(join(root, "AGENTS.md"), "utf8")).match(/harness-memory:start/g)).toHaveLength(1);
  });

  it("refuses stale previews and never silently overwrites changed user files", async () => {
    const rule = convention(); const preview = await publication.preview(root, [rule.id]);
    await writeFile(join(root, "AGENTS.md"), "new handwritten content");
    await expect(publication.publish(root, [rule.id], preview.token)).rejects.toThrow("变化");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("new handwritten content");
    const next = await publication.preview(root, [rule.id]);
    memory.update(rule.id, { content: "Use another library" }, "user");
    await expect(publication.publish(root, [rule.id], next.token)).rejects.toThrow();
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("new handwritten content");
  });

  it.each(["edit", "delete", "expire", "replace"])("stops loading outdated published rules after %s and can clear the managed section", async action => {
    await writeFile(join(root, "AGENTS.md"), "Keep manual rules.\n");
    const rule = convention(), preview = await publication.preview(root, [rule.id]);
    await publication.publish(root, [rule.id], preview.token);
    if (action === "edit") memory.update(rule.id, { content: "A changed convention" }, "user");
    if (action === "delete") memory.delete(rule.id);
    if (action === "expire") memory.update(rule.id, { expiresAt: "2000-01-01T00:00:00.000Z" }, "user");
    if (action === "replace") {
      const replacement = memory.propose({ content: "A replacement convention", scope: "project", scopeId: root, source: "run:2", confidence: 1, kind: "convention", key: "ui.library" });
      memory.decide(replacement.id, true, "user", true);
    }
    const instructions = await trust.loadInstructions(root);
    expect(instructions).toContain("Keep manual rules."); expect(instructions).not.toContain(rule.content);
    const clear = await publication.preview(root, []);
    await publication.publish(root, [], clear.token);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).not.toContain(rule.content);
  });

  it("rejects foreign/unapproved records and broken markers", async () => {
    const rule = convention();
    memory.update(rule.id, { content: "changed" }, "user");
    await expect(publication.preview(root, [rule.id])).rejects.toThrow("已批准");
    const global = memory.create({ content: "Use Chinese", kind: "preference", key: "language", scope: "global", scopeId: "global" }, "user");
    await expect(publication.preview(root, [global.id])).rejects.toThrow("当前项目");
    await writeFile(join(root, "AGENTS.md"), "<!-- harness-memory:start -->\nIncomplete");
    await expect(publication.preview(root, [])).rejects.toThrow("标记");
  });

  it("rejects linked publication directories", async () => {
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "docs"), "junction");
    await expect(publication.preview(root, [])).rejects.toThrow("链接");
  });

  it("rolls back written files if selected knowledge changes during publication", async () => {
    await writeFile(join(root, "AGENTS.md"), "Handwritten content\n");
    const rule = convention(), preview = await publication.preview(root, [rule.id]);
    const originalList = memory.list.bind(memory);
    let count = 0;
    vi.spyOn(memory, "list").mockImplementation((scopeId) => {
      // accepted snapshot, preview snapshot, validation, then final validation after writes
      if (++count === 4) memory.update(rule.id, { content: "Concurrent edit" }, "user");
      return originalList(scopeId);
    });
    await expect(publication.publish(root, [rule.id], preview.token)).rejects.toThrow("变化");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("Handwritten content\n");
    await expect(readFile(join(root, "docs/agent-knowledge.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await trust.loadInstructions(root)).toBeUndefined();
  });
});
