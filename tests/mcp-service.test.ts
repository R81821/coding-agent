import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpStore } from "../packages/extensions/src/mcp-store.js";
import { McpService } from "../packages/extensions/src/mcp-service.js";

const serverFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
const signal = () => new AbortController().signal;
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-service-")));
  const a = join(root, "a"), b = join(root, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-service-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const store = new McpStore(database), service = new McpService(store);
  cleanup.push(async () => { await service.close(); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  const view = await service.save({ name: "Fixture", transport: { type: "stdio", command: process.execPath, args: [serverFile] }, enabled: true, projectPaths: [a, b], callTimeoutMs: 2000 });
  return { a, b, store, service, view };
}
test("isolates the same server across projects while deduplicating concurrent connects within one project", async () => {
  const { service, view, a, b } = await fixture();
  const [first, same, second] = await Promise.all([service.connect(view.id, a, signal()), service.connect(view.id, a, signal()), service.connect(view.id, b, signal())]);
  expect(first).toBe(same);
  const [ra, rb] = await Promise.all([first.callTool("echo", {}, signal()), second.callTool("echo", {}, signal())]);
  expect(ra.structuredContent).toMatchObject({ cwd: a, roots: [{ uri: pathToFileURL(a).href }] });
  expect(rb.structuredContent).toMatchObject({ cwd: b, roots: [{ uri: pathToFileURL(b).href }] });
  expect(ra.structuredContent?.pid).not.toEqual(rb.structuredContent?.pid);
  expect(await service.statuses(a)).toEqual([expect.objectContaining({ state: "connected", toolCount: 4, revision: 1 })]);
});
test("disabling a service cancels in-flight calls and closes its process", async () => {
  const { service, view, a } = await fixture();
  const connection = await service.connect(view.id, a, signal());
  const pid = (await connection.callTool("echo", {}, signal())).structuredContent!.pid as number;
  const pending = connection.callTool("slow", {}, signal());
  const cancelled = expect(pending).rejects.toMatchObject({ code: "closed" });
  await service.save({ ...view, expectedRevision: 1, enabled: false });
  await cancelled;
  expect(connection.closed).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(service.connect(view.id, a, signal())).rejects.toMatchObject({ code: "not_allowed" });
  expect(await service.statuses(a)).toEqual([expect.objectContaining({ state: "disabled" })]);
});
test("a configuration update revokes old handles before the next call", async () => {
  const { service, store, view, a } = await fixture();
  const connection = await service.connect(view.id, a, signal());
  // Even a backend caller bypassing the service cannot use a stale capability.
  await store.save({ ...view, expectedRevision: 1, readOnlyTools: ["echo"] });
  await expect(connection.callTool("echo", {}, signal())).rejects.toMatchObject({ code: "closed" });
  const fresh = await service.connect(view.id, a, signal());
  expect(fresh).not.toBe(connection);
  await expect(fresh.callTool("echo", {}, signal())).resolves.toHaveProperty("content");
});
test("invalidation during initialization never republishes the stale connection", async () => {
  const { service, view, a } = await fixture();
  const delayed = await service.save({ ...view, expectedRevision: 1, env: { FIXTURE_INIT_DELAY: "700" } });
  const pending = service.connect(view.id, a, signal());
  const cancelled = expect(pending).rejects.toMatchObject({ code: "closed" });
  await new Promise(resolve => setTimeout(resolve, 60));
  await service.save({ ...delayed, expectedRevision: delayed.revision, enabled: false });
  await cancelled;
  expect(await service.statuses(a)).toEqual([expect.objectContaining({ state: "disabled", toolCount: 0 })]);
});
test("cancelling one concurrent waiter does not cancel another project connection request", async () => {
  const { service, view, a } = await fixture();
  await service.save({ ...view, expectedRevision: 1, env: { FIXTURE_INIT_DELAY: "150" } });
  const controller = new AbortController();
  const first = service.connect(view.id, a, controller.signal);
  const cancelled = expect(first).rejects.toMatchObject({ code: "cancelled" });
  const second = service.connect(view.id, a, signal());
  setTimeout(() => controller.abort(), 60);
  await cancelled;
  expect((await second).closed).toBe(false);
});
test("deleting a service closes both projects and removes public state", async () => {
  const { service, view, a, b } = await fixture();
  const connections = await Promise.all([service.connect(view.id, a, signal()), service.connect(view.id, b, signal())]);
  await expect(service.remove(view.id, 9)).rejects.toThrow(/revision/);
  expect(connections.every(connection => !connection.closed)).toBe(true);
  await service.remove(view.id, 1);
  expect(connections.every(connection => connection.closed)).toBe(true);
  expect(await service.statuses(a)).toEqual([]);
});
test("a closed connection is re-established instead of being reused", async () => {
  const { service, view, a } = await fixture();
  const first = await service.connect(view.id, a, signal());
  await first.close();
  const second = await service.connect(view.id, a, signal());
  expect(second).not.toBe(first);
  expect(second.closed).toBe(false);
  expect((await second.callTool("echo", {}, signal())).structuredContent).toMatchObject({ cwd: a });
});
