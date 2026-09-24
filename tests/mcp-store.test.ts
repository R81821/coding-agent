import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpServerInputSchema } from "@harness/protocol";
import { McpStore } from "@harness/extensions";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-mcp-store-"));
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-store-fixture-password");
  let database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  cleanup.push(async () => { database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  return {
    root, store: new McpStore(database),
    async reopen() { database.close(); database = await HarnessDatabase.open(join(root, "state.sqlite"), vault); return new McpStore(database); },
    async disk() { return (await readFile(join(root, "state.sqlite"))).toString("utf8"); },
  };
}

describe("MCP encrypted configuration", () => {
  it("persists across reopen and exposes only secret names", async () => {
    const f = await fixture();
    const view = await f.store.save({ name: "Remote", transport: { type: "streamable_http", url: "https://mcp.example.test/mcp" }, projectPaths: [f.root], headers: { Authorization: "Bearer fixture-mcp-secret-16342" } });
    expect(view).toMatchObject({ revision: 1, enabled: false, headerKeys: ["Authorization"], envKeys: [] });
    expect(JSON.stringify(view)).not.toContain("fixture-mcp-secret");
    const reopened = await f.reopen();
    expect(reopened.get(view.id)?.headers.Authorization).toBe("Bearer fixture-mcp-secret-16342");
    expect(reopened.list()).toEqual([view]);
    expect(await f.disk()).not.toContain("fixture-mcp-secret-16342");
  });

  it("preserves omitted secrets, replaces values and deletes only explicit nulls", async () => {
    const f = await fixture();
    const original = await f.store.save({ name: "Local", transport: { type: "stdio", command: "node", args: ["server.mjs"] }, projectPaths: [f.root], env: { TOKEN: "old", EMPTY: "" } });
    const saved = await f.store.save({ ...original, expectedRevision: 1, name: "Renamed" });
    expect(f.store.get(saved.id)?.env).toEqual({ TOKEN: "old", EMPTY: "" });
    await f.store.save({ ...saved, expectedRevision: 2, env: { TOKEN: "new", EMPTY: null } });
    expect(f.store.get(saved.id)?.env).toEqual({ TOKEN: "new" });
    await expect(f.store.save({ ...saved, expectedRevision: 2, name: "Stale edit" })).rejects.toThrow(/revision/i);
    expect(f.store.get(saved.id)?.revision).toBe(3);
  });

  it("requires a revision for updates and deletion and never replaces a stale record", async () => {
    const f = await fixture();
    const view = await f.store.save({ name: "Local", transport: { type: "stdio", command: "node", args: [] }, projectPaths: [f.root] });
    await expect(f.store.save({ ...view })).rejects.toThrow(/revision/i);
    expect(() => f.store.remove(view.id, 9)).toThrow(/revision/i);
    f.store.remove(view.id, 1);
    expect(f.store.list()).toEqual([]);
  });

  it("canonicalizes duplicate project paths and rejects relative or absent projects", async () => {
    const f = await fixture();
    const input = { name: "Local", transport: { type: "stdio" as const, command: "node", args: [] }, projectPaths: [f.root, join(f.root, ".")] };
    const view = await f.store.save(input);
    expect(view.projectPaths).toHaveLength(1);
    await expect(f.store.save({ ...input, projectPaths: ["relative-project"] })).rejects.toThrow(/absolute/i);
    await expect(f.store.save({ ...input, projectPaths: [join(f.root, "missing")] })).rejects.toThrow(/project/i);
  });

  it("allows only one concurrent edit with the same expected revision", async () => {
    const f = await fixture();
    const view = await f.store.save({ name: "Local", transport: { type: "stdio", command: "node", args: [] }, projectPaths: [f.root] });
    const outcomes = await Promise.allSettled(["A", "B"].map(name => f.store.save({ ...view, expectedRevision: 1, name })));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.store.get(view.id)?.revision).toBe(2);
  });

  it.each([
    { transport: { type: "streamable_http", url: "file:///secret" } },
    { transport: { type: "sse", url: "https://user:pass@example.test/mcp" } },
    { transport: { type: "stdio", command: "", args: [] } },
    { transport: { type: "stdio", command: "node", args: ["bad\u0000argument"] } },
    { headers: { Authorization: "Bearer token\r\nx-evil: yes" } },
    { headers: { "Content-Length": "1" } },
    { env: { "BAD=NAME": "x" } },
  ])("rejects malformed configuration before persistence: %j", patch => {
    expect(McpServerInputSchema.safeParse({ name: "test", transport: { type: "streamable_http", url: "https://mcp.example.test" }, projectPaths: [], ...patch }).success).toBe(false);
  });
});
