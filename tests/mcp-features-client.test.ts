import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpServerConfigSchema } from "@harness/protocol";
import { connectMcp, type McpConnection, type McpConnectionCallbacks, type McpRequestHandlers } from "../packages/extensions/src/mcp-client.js";
import { McpService } from "../packages/extensions/src/mcp-service.js";
import { McpStore } from "../packages/extensions/src/mcp-store.js";

const fixture = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-features-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const signal = () => new AbortController().signal;
let project: string;
beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-features-")));
  cleanups.push(() => rm(project, { recursive: true, force: true }));
});
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function config(extra: Record<string, unknown> = {}) {
  return McpServerConfigSchema.parse({ id: "features", name: "Features", revision: 1, enabled: true, projectPaths: [project], transport: { type: "stdio", command: process.execPath, args: [fixture] }, connectTimeoutMs: 5000, callTimeoutMs: 2000, ...extra });
}
async function open(extra: Record<string, unknown> = {}, callbacks: McpConnectionCallbacks = {}) {
  const connection = await connectMcp(config(extra), project, signal(), callbacks);
  cleanups.push(() => connection.close());
  return connection;
}
async function remote(mode: string) {
  const child = spawn(process.execPath, [fixture, mode], { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanups.push(() => closeProcess(child));
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Feature fixture startup timed out")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Feature fixture exited before ready")); });
    child.stdout!.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0]!).url); } });
  });
}
function closeProcess(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve()); child.kill();
  });
}
async function serviceFixture(extra: Record<string, unknown> = {}) {
  const second = join(project, "second"); await mkdir(second);
  const vault = await VaultCrypto.open(join(project, "key.json"), "mcp-features-fixture-password");
  const database = await HarnessDatabase.open(join(project, "state.sqlite"), vault);
  const service = new McpService(new McpStore(database));
  cleanups.push(async () => { await service.close(); database.close(); vault.dispose(); });
  const view = await service.save({ name: "Features", transport: { type: "stdio", command: process.execPath, args: [fixture] }, enabled: true, projectPaths: [project, second], callTimeoutMs: 2000, ...extra });
  return { service, view, second };
}
const sampling: NonNullable<McpRequestHandlers["onSampling"]> = async () => ({ role: "assistant", model: "fixture-model", content: { type: "text", text: "Sampled answer" }, stopReason: "endTurn" });

test.each(["stdio", "streamable_http", "sse"])("%s supports paged resources, templates, prompts and completions with typed content", async mode => {
  const connection = await open(mode === "stdio" ? {} : { transport: { type: mode, url: await remote(mode) } });
  expect(connection.capabilities).toEqual({ tools: true, resources: true, prompts: true });
  expect((await connection.listResources(signal())).map(item => item.uri)).toEqual(["fixture://first", "fixture://second"]);
  expect((await connection.listResourceTemplates(signal())).map(item => item.uriTemplate)).toEqual(["fixture://topics/{topic}", "fixture://files/{name}"]);
  expect((await connection.listPrompts(signal())).map(item => item.name)).toEqual(["review", "explain"]);
  expect(await connection.readResource("fixture://first", signal())).toMatchObject({ contents: [{ uri: "fixture://first", text: "fixture://first read 1" }] });
  expect(await connection.readResource("fixture://binary", signal())).toMatchObject({ contents: [{ blob: Buffer.from("fixture binary").toString("base64") }] });
  const result = await connection.getPrompt("review", { topic: "MCP" }, signal());
  expect(result.messages.map(item => item.content.type)).toEqual(["text", "resource", "image"]);
  expect(result.messages[0]?.content).toMatchObject({ text: "Review MCP" });
  for (const ref of [{ type: "ref/prompt" as const, name: "review" }, { type: "ref/resource" as const, uri: "fixture://topics/{topic}" }]) {
    expect(await connection.complete({ ref, argument: { name: "topic", value: "mc" }, context: { arguments: { locale: "zh" } } }, signal())).toMatchObject({ completion: { values: ["mc-one", "mc-two"], total: 2, hasMore: false } });
  }
}, 15_000);

test.each(["stdio", "streamable_http", "sse"])("%s routes sampling, form and URL elicitation through supplied handlers", async mode => {
  const onSampling = vi.fn(sampling);
  const onElicitation = vi.fn<NonNullable<McpRequestHandlers["onElicitation"]>>(async params => params.mode === "url" ? { action: "decline" } : { action: "accept", content: { topic: "Chosen topic" } });
  // Reverse HTTP/SSE callbacks schedule several local server turns under full-suite load.
  // Deadline/cancellation behavior has separate tests with explicit short callTimeoutMs.
  const connection = await open({ callTimeoutMs: 5000, ...(mode === "stdio" ? {} : { transport: { type: mode, url: await remote(mode) } }) }, { requestHandlers: { onSampling, onElicitation } });
  const inspection = await connection.callTool("inspect", {}, signal());
  expect(inspection.structuredContent).toMatchObject({ capabilities: { sampling: {}, elicitation: { form: {}, url: {} } }, roots: [{ uri: pathToFileURL(project).href }] });
  expect((await connection.callTool("sample", {}, signal())).structuredContent).toMatchObject({ model: "fixture-model", content: { text: "Sampled answer" } });
  expect((await connection.callTool("form", {}, signal())).structuredContent).toEqual({ action: "accept", content: { topic: "Chosen topic" } });
  expect((await connection.callTool("url", {}, signal())).structuredContent).toEqual({ action: "decline" });
  expect(onSampling).toHaveBeenCalledTimes(1);
  expect(onSampling).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 64 }), expect.any(AbortSignal), { serverId: "features", serverName: "Features", workspacePath: project });
  expect(onElicitation).toHaveBeenCalledTimes(2);
}, 15_000);

test("does not advertise reverse capabilities without corresponding handlers", async () => {
  const plain = await open();
  const caps = (await plain.callTool("inspect", {}, signal())).structuredContent!.capabilities as Record<string, unknown>;
  expect(caps.sampling).toBeUndefined(); expect(caps.elicitation).toBeUndefined();
  const onlySampling = await open({}, { requestHandlers: { onSampling: sampling } });
  const samplingCaps = (await onlySampling.callTool("inspect", {}, signal())).structuredContent!.capabilities as Record<string, unknown>;
  expect(samplingCaps.sampling).toEqual({}); expect(samplingCaps.elicitation).toBeUndefined();
  const onlyElicitation = await open({}, { requestHandlers: { onElicitation: async () => ({ action: "cancel" }) } });
  const elicitationCaps = (await onlyElicitation.callTool("inspect", {}, signal())).structuredContent!.capabilities as Record<string, unknown>;
  expect(elicitationCaps.sampling).toBeUndefined(); expect(elicitationCaps.elicitation).toEqual({ form: {}, url: {} });
});

test("resources and prompts work when the service provides no tools", async () => {
  const { service, view } = await serviceFixture({ env: { FIXTURE_NO_TOOLS: "1" } });
  const connection = await service.connect(view.id, project, signal());
  expect(connection.capabilities).toEqual({ tools: false, resources: true, prompts: true });
  expect(await service.statuses(project)).toMatchObject([{ state: "connected", toolCount: 0, capabilities: { tools: false, resources: true, prompts: true } }]);
  expect((await service.statuses(project))[0]?.resourceCount).toBeUndefined();
  expect((await service.statuses(project))[0]?.promptCount).toBeUndefined();
  expect(await connection.listTools(signal())).toEqual([]);
  expect((await service.resources(view.id, project, signal())).resources).toHaveLength(2);
  expect((await service.prompts(view.id, project, signal())).prompts).toHaveLength(2);
  expect(await service.statuses(project)).toMatchObject([{ resourceCount: 2, promptCount: 2 }]);
  expect(await service.getPrompt(view.id, project, "review", { topic: "only resources" }, signal())).toMatchObject({ messages: [{ content: { text: "Review only resources" } }, {}, {}] });
});

test.each(["FIXTURE_NO_RESOURCE_LIST", "FIXTURE_NO_TEMPLATE_LIST"])("%s does not disable the server's remaining resource capability", async flag => {
  const connection = await open({ env: { [flag]: "1" } });
  expect(await connection.listResources(signal())).toHaveLength(flag === "FIXTURE_NO_RESOURCE_LIST" ? 0 : 2);
  expect(await connection.listResourceTemplates(signal())).toHaveLength(flag === "FIXTURE_NO_TEMPLATE_LIST" ? 0 : 2);
  expect(await connection.readResource("fixture://first", signal())).toMatchObject({ contents: [{ text: "fixture://first read 1" }] });
});

test.each(["FIXTURE_LOOP_LIST", "FIXTURE_DUPLICATE_LIST", "FIXTURE_OVERSIZED_LIST", "FIXTURE_INVALID_LIST"])("rejects invalid %s resources, templates and prompts", async flag => {
  const connection = await open({ env: { [flag]: "1" } });
  for (const list of [() => connection.listResources(signal()), () => connection.listResourceTemplates(signal()), () => connection.listPrompts(signal())]) {
    await expect(list()).rejects.toMatchObject({ code: "protocol_error" });
  }
}, 15_000);

test("catalog and read calls use one deadline and caller cancellation without replaying reads", async () => {
  const slowCatalog = await open({ env: { FIXTURE_SLOW_LIST: "1" }, callTimeoutMs: 100 });
  await expect(slowCatalog.listResources(signal())).rejects.toMatchObject({ code: "timeout" });
  const controller = new AbortController();
  const pending = slowCatalog.listPrompts(controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  setTimeout(() => controller.abort(), 20); await cancelled;
  const connection = await open({ callTimeoutMs: 100 });
  await expect(connection.readResource("fixture://slow", signal())).rejects.toMatchObject({ code: "timeout" });
  const inspection = await connection.callTool("inspect", {}, signal());
  expect(inspection.structuredContent).toMatchObject({ reads: 1, cancelled: 1 });
  expect(await connection.readResource("fixture://first", signal())).toMatchObject({ contents: [{ text: "fixture://first read 2" }] });
});

test("rejects invalid local prompt and completion inputs before contacting the server", async () => {
  const connection = await open();
  expect(() => connection.getPrompt("review", { topic: 42 } as unknown as Record<string, string>, signal())).toThrow(expect.objectContaining({ code: "protocol_error" }));
  expect(() => connection.complete({ ref: { type: "ref/prompt", name: "review" }, argument: { name: "topic", value: 42 } } as unknown as Parameters<McpConnection["complete"]>[0], signal())).toThrow(expect.objectContaining({ code: "protocol_error" }));
});

test("subscriptions notify metadata only, consume updates once and never fetch contents automatically", async () => {
  const { service, view } = await serviceFixture();
  const connection = await service.connect(view.id, project, signal());
  await service.subscribeResource(view.id, project, "fixture://first", signal());
  await connection.callTool("notify", {}, signal());
  expect(await service.resourceUpdates(view.id, project)).toEqual({ uris: ["fixture://first"], catalogRevision: 3 });
  expect(await service.resourceUpdates(view.id, project)).toEqual({ uris: [], catalogRevision: 3 });
  expect((await connection.callTool("inspect", {}, signal())).structuredContent).toMatchObject({ reads: 0, subscribed: ["fixture://first"] });
  await service.unsubscribeResource(view.id, project, "fixture://first", signal());
  await connection.callTool("notify", {}, signal());
  expect(await service.resourceUpdates(view.id, project)).toEqual({ uris: [], catalogRevision: 5 });
  await service.disconnect(view.id, project);
  expect(await service.resourceUpdates(view.id, project)).toEqual({ uris: [], catalogRevision: 0 });
});

test("direct connection subscriptions deliver all catalog and resource notifications", async () => {
  const callbacks = { onResourcesChanged: vi.fn(), onPromptsChanged: vi.fn(), onResourceUpdated: vi.fn() };
  const connection = await open({}, callbacks);
  await connection.subscribeResource("fixture://second", signal());
  await connection.callTool("notify", {}, signal());
  expect(callbacks.onResourcesChanged).toHaveBeenCalledTimes(1);
  expect(callbacks.onPromptsChanged).toHaveBeenCalledTimes(1);
  expect(callbacks.onResourceUpdated).toHaveBeenCalledWith("fixture://second");
  await connection.unsubscribeResource("fixture://second", signal());
});

test.each(["stdio", "streamable_http"])("%s reverse-capable run leases are independent from management and concurrent runs", async mode => {
  const { service, view, second } = await serviceFixture(mode === "stdio" ? {} : { transport: { type: mode, url: await remote(mode) } });
  const management = await service.connect(view.id, project, signal());
  const onFirst = vi.fn(async () => ({ ...(await sampling({ messages: [], maxTokens: 64 }, signal(), { serverId: view.id, serverName: view.name, workspacePath: project })), content: { type: "text" as const, text: "First run" } }));
  const onSecond = vi.fn(async () => ({ ...(await sampling({ messages: [], maxTokens: 64 }, signal(), { serverId: view.id, serverName: view.name, workspacePath: project })), content: { type: "text" as const, text: "Second run" } }));
  const first = await service.acquire(view.id, project, signal(), { onSampling: onFirst });
  const next = await service.acquire(view.id, project, signal(), { onSampling: onSecond });
  const otherProject = await service.acquire(view.id, second, signal(), { onSampling: sampling });
  const plain = await service.acquire(view.id, project, signal());
  expect(plain.connection).toBe(management);
  expect(new Set([management, first.connection, next.connection, otherProject.connection]).size).toBe(4);
  const [firstResult, secondResult] = await Promise.all([first.connection.callTool("sample", {}, signal()), next.connection.callTool("sample", {}, signal())]);
  expect(firstResult.structuredContent).toMatchObject({ content: { text: "First run" } });
  expect(secondResult.structuredContent).toMatchObject({ content: { text: "Second run" } });
  expect(onFirst).toHaveBeenCalledTimes(1); expect(onSecond).toHaveBeenCalledTimes(1);
  const roots = (await otherProject.connection.callTool("inspect", {}, signal())).structuredContent!.roots;
  expect(roots).toEqual([{ uri: pathToFileURL(second).href, name: "second" }]);
  await first.close();
  expect(first.connection.closed).toBe(true); expect(next.connection.closed).toBe(false); expect(management.closed).toBe(false);
  await Promise.all([next.close(), otherProject.close(), plain.close()]);
  expect(management.closed).toBe(false);
}, 15_000);

test.each(["disable", "disconnect", "remove", "close"])("%s revokes management and every isolated run lease", async action => {
  const { service, view } = await serviceFixture();
  const management = await service.connect(view.id, project, signal());
  const leases = await Promise.all([service.acquire(view.id, project, signal(), { onSampling: sampling }), service.acquire(view.id, project, signal(), { onElicitation: async () => ({ action: "cancel" }) })]);
  if (action === "disable") await service.save({ ...view, expectedRevision: view.revision, enabled: false });
  else if (action === "disconnect") await service.disconnect(view.id, project);
  else if (action === "remove") await service.remove(view.id, view.revision);
  else await service.close();
  expect([management, ...leases.map(lease => lease.connection)].every(connection => connection.closed)).toBe(true);
  for (const lease of leases) await expect(lease.connection.listPrompts(signal())).rejects.toMatchObject({ code: "closed" });
});

test("run cancellation aborts a pending reverse request and closes only its isolated lease", async () => {
  const { service, view } = await serviceFixture();
  const management = await service.connect(view.id, project, signal());
  const controller = new AbortController();
  let incoming: AbortSignal | undefined;
  let resolveEntered!: () => void;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const lease = await service.acquire(view.id, project, controller.signal, { onSampling: async (_params, active) => {
    incoming = active; resolveEntered();
    await new Promise<void>(resolve => active.addEventListener("abort", () => resolve(), { once: true }));
    return sampling({ messages: [], maxTokens: 64 }, active, { serverId: view.id, serverName: view.name, workspacePath: project });
  } });
  const pending = lease.connection.callTool("sample", {}, signal());
  const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
  await entered; controller.abort(); await rejected;
  expect(incoming?.aborted).toBe(true); expect(lease.connection.closed).toBe(true); expect(management.closed).toBe(false);
  await lease.close();
});

test.each(["stdio", "streamable_http", "sse"].flatMap(mode => ["sample", "form", "url"].map(operation => [mode, operation])))("%s parent call cancellation reaches a pending %s reverse request without closing the lease", async (mode, operation) => {
  let incoming: AbortSignal | undefined;
  let resolveEntered!: () => void;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const handlers: McpRequestHandlers = {
    onSampling: async (_params, active) => {
      incoming = active; resolveEntered();
      await new Promise<void>(resolve => active.addEventListener("abort", () => resolve(), { once: true }));
      return sampling({ messages: [], maxTokens: 64 }, active, { serverId: "features", serverName: "Features", workspacePath: project });
    },
    onElicitation: async (_params, active) => {
      incoming = active; resolveEntered();
      await new Promise<void>(resolve => active.addEventListener("abort", () => resolve(), { once: true }));
      return { action: "cancel" };
    },
  };
  const connection = await open(mode === "stdio" ? {} : { transport: { type: mode, url: await remote(mode!) } }, { requestHandlers: handlers });
  const controller = new AbortController();
  const pending = connection.callTool(operation!, {}, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await entered; controller.abort(); await cancelled;
  await vi.waitFor(() => expect(incoming?.aborted).toBe(true));
  expect(connection.closed).toBe(false);
  await expect(connection.callTool("inspect", {}, signal())).resolves.toHaveProperty("structuredContent");
});

test("reverse handler failures are sanitized and do not expose handler secrets to the server", async () => {
  const connection = await open({}, { requestHandlers: { onSampling: async () => { throw new Error("fixture-private-secret"); } } });
  await expect(connection.callTool("sample", {}, signal())).rejects.toMatchObject({ code: "connection_failed" });
  await expect(connection.callTool("inspect", {}, signal())).resolves.toHaveProperty("structuredContent");
});
