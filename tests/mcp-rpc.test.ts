import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DaemonRequestSchema } from "@harness/protocol";
import { canonicalMcpProject, McpStore, McpService } from "@harness/extensions";
import { McpInteractionBroker } from "@harness/core";
import { McpOAuthManager } from "../packages/extensions/src/mcp-oauth.js";
import { dispatchMcp, isMcpRequest } from "../apps/daemon/src/mcp-rpc.js";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-mcp-rpc-"));
  const crypto = await VaultCrypto.open(join(root, "key.json"), "mcp-rpc-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), crypto);
  const store = new McpStore(database), mcp = new McpService(store), mcpAuth = new McpOAuthManager(database, store);
  const mcpInteractions = new McpInteractionBroker();
  cleanup.push(async () => { mcpInteractions.close(); await mcp.close(); await mcpAuth.close(); database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  const rpc = async (method: string, params?: unknown) => {
    const sanitized = sanitizeRendererRequest(method, params);
    const request = DaemonRequestSchema.parse({ id: "test", ...sanitized });
    if (!isMcpRequest(request)) throw new Error("Expected MCP request");
    return dispatchMcp(request, { mcp, mcpAuth, engine: { mcpInteractions } });
  };
  return { root, mcp, rpc, mcpInteractions };
}
test("management RPC saves, lists and deletes without exposing stored secrets", async () => {
  const f = await fixture();
  const saved = await f.rpc("mcp.save", { name: "Secret", enabled: false, projectPaths: [f.root], transport: { type: "streamable_http", url: "https://mcp.example.test/mcp" }, headers: { Authorization: "Bearer rpc-fixture-secret" } }) as { id: string; revision: number };
  const snapshot = await f.rpc("mcp.list", { workspacePath: f.root });
  expect(JSON.stringify(snapshot)).not.toContain("rpc-fixture-secret");
  expect(snapshot).toMatchObject({ servers: [{ id: saved.id, headerKeys: ["Authorization"] }], statuses: [{ state: "disabled" }] });
  await expect(f.rpc("mcp.remove", { serverId: saved.id, expectedRevision: 9 })).rejects.toThrow(/revision/);
  await f.rpc("mcp.remove", { serverId: saved.id, expectedRevision: saved.revision });
  expect(f.mcp.store.list()).toEqual([]);
});
test("JSON import previews disabled configurations without persisting or executing commands", async () => {
  const f = await fixture();
  const marker = join(f.root, "should-not-exist.txt");
  const preview = await f.rpc("mcp.import", { source: JSON.stringify({ mcpServers: { local: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], env: { TOKEN: "import-secret" } }, remote: { type: "http", url: "https://mcp.example.test/mcp" } } }), workspacePath: f.root });
  expect(preview).toMatchObject({ servers: [{ name: "local", enabled: false, transport: { type: "stdio" } }, { name: "remote", enabled: false, transport: { type: "streamable_http" } }] });
  expect(f.mcp.store.list()).toEqual([]);
  await expect(readFile(marker)).rejects.toThrow();
  await expect(f.rpc("mcp.import", { source: '{"mcpServers":{"bad":{"url":"file:///etc/passwd"}}}', workspacePath: f.root })).rejects.toThrow(/import/i);
});
test("MCP renderer methods remain schema-validated and never expose direct tool execution", async () => {
  const f = await fixture();
  await expect(f.rpc("mcp.callTool", { name: "write" })).rejects.toThrow(/cannot invoke/);
  await expect(f.rpc("mcp.connect", { serverId: "x" })).rejects.toThrow();
  await expect(f.rpc("mcp.save", { name: "invalid", transport: { type: "stdio", command: "node" }, headers: { Authorization: "secret\r\nInjected: bad" } })).rejects.toThrow();
});

test("resource, prompt, completion and subscription RPCs use the allowed project connection", async () => {
  const f = await fixture();
  const server = await f.rpc("mcp.save", {
    name: "Features", enabled: true, projectPaths: [f.root],
    transport: { type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-features-server.mjs", import.meta.url))] },
  }) as { id: string };
  const scope = { serverId: server.id, workspacePath: f.root };
  expect(await f.rpc("mcp.resources", scope)).toMatchObject({
    resources: [{ uri: "fixture://first" }, { uri: "fixture://second" }],
    resourceTemplates: [{ uriTemplate: "fixture://topics/{topic}" }, { uriTemplate: "fixture://files/{name}" }],
  });
  expect(await f.rpc("mcp.resource.read", { ...scope, uri: "fixture://first" })).toMatchObject({ contents: [{ text: "fixture://first read 1" }] });
  expect(await f.rpc("mcp.prompts", scope)).toMatchObject({ prompts: [{ name: "review" }, { name: "explain" }] });
  expect(await f.rpc("mcp.prompt.get", { ...scope, name: "review", arguments: { topic: "RPC topic" } })).toMatchObject({ messages: [{ content: { text: "Review RPC topic" } }, {}, {}] });
  for (const ref of [{ type: "ref/prompt", name: "review" }, { type: "ref/resource", uri: "fixture://topics/{topic}" }]) {
    expect(await f.rpc("mcp.completion", { ...scope, ref, argument: { name: "topic", value: "rpc" }, context: { arguments: { locale: "zh" } } })).toMatchObject({ completion: { values: ["rpc-one", "rpc-two"] } });
  }
  expect(await f.rpc("mcp.resource.subscribe", { ...scope, uri: "fixture://first" })).toEqual({ subscribed: true });
  const connection = await f.mcp.connect(server.id, f.root, new AbortController().signal);
  await connection.callTool("notify", {}, new AbortController().signal);
  expect(await f.rpc("mcp.resource.updates", scope)).toEqual({ uris: ["fixture://first"], catalogRevision: 3 });
  expect(await f.rpc("mcp.resource.updates", scope)).toEqual({ uris: [], catalogRevision: 3 });
  expect((await connection.callTool("inspect", {}, new AbortController().signal)).structuredContent).toMatchObject({ reads: 1, subscribed: ["fixture://first"] });
  expect(await f.rpc("mcp.resource.unsubscribe", { ...scope, uri: "fixture://first" })).toEqual({ subscribed: false });
  await connection.callTool("notify", {}, new AbortController().signal);
  expect(await f.rpc("mcp.resource.updates", scope)).toEqual({ uris: [], catalogRevision: 5 });

  const other = join(f.root, "other-project"); await mkdir(other);
  for (const [method, extra] of [
    ["mcp.resources", {}], ["mcp.resource.read", { uri: "fixture://first" }],
    ["mcp.resource.subscribe", { uri: "fixture://first" }], ["mcp.resource.unsubscribe", { uri: "fixture://first" }],
    ["mcp.resource.updates", {}], ["mcp.prompts", {}],
    ["mcp.prompt.get", { name: "review", arguments: { topic: "scope" } }],
    ["mcp.completion", { ref: { type: "ref/prompt", name: "review" }, argument: { name: "topic", value: "x" } }],
  ] as const) {
    await expect(f.rpc(method, { serverId: server.id, workspacePath: other, ...extra })).rejects.toMatchObject({ code: "not_allowed" });
  }
}, 15_000);

test("management content and update metadata redact configured credentials while preserving binary payloads", async () => {
  const f = await fixture(), secret = "rpc-content-fixture-secret";
  const server = await f.rpc("mcp.save", { name: "Secret content", enabled: true, projectPaths: [f.root], transport: { type: "stdio", command: process.execPath }, env: { FIXTURE_SECRET: secret } }) as { id: string };
  const scope = { serverId: server.id, workspacePath: f.root };
  vi.spyOn(f.mcp, "resources").mockResolvedValue({ resources: [{ uri: `fixture://${secret}`, name: secret }], resourceTemplates: [{ uriTemplate: `fixture://${secret}/{topic}`, name: secret }], catalogRevision: 1 });
  vi.spyOn(f.mcp, "prompts").mockResolvedValue({ prompts: [{ name: "review", description: secret }], catalogRevision: 1 });
  vi.spyOn(f.mcp, "readResource").mockResolvedValue({ contents: [{ uri: `fixture://${secret}`, text: secret }, { uri: "fixture://binary", blob: secret }] });
  vi.spyOn(f.mcp, "getPrompt").mockResolvedValue({ messages: [{ role: "user", content: { type: "text", text: secret } }, { role: "user", content: { type: "image", mimeType: "image/png", data: secret } }] });
  vi.spyOn(f.mcp, "complete").mockResolvedValue({ completion: { values: [secret] } });
  vi.spyOn(f.mcp, "resourceUpdates").mockResolvedValue({ uris: [`fixture://${secret}`], catalogRevision: 1 });
  for (const [method, extra] of [["mcp.resources", {}], ["mcp.prompts", {}], ["mcp.completion", { ref: { type: "ref/prompt", name: "review" }, argument: { name: "topic", value: "x" } }], ["mcp.resource.updates", {}]] as const) {
    const result = await f.rpc(method, { ...scope, ...extra });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[redacted]");
  }
  expect(await f.rpc("mcp.resource.read", { ...scope, uri: "fixture://first" })).toEqual({ contents: [{ uri: "fixture://[redacted]", text: "[redacted]" }, { uri: "fixture://binary", blob: secret }] });
  expect(await f.rpc("mcp.prompt.get", { ...scope, name: "review", arguments: {} })).toEqual({ messages: [{ role: "user", content: { type: "text", text: "[redacted]" } }, { role: "user", content: { type: "image", mimeType: "image/png", data: secret } }] });
});

test("interaction RPCs canonicalize projects, filter runs and reject invalid or foreign user responses", async () => {
  const f = await fixture(), canonical = await canonicalMcpProject(f.root);
  const other = join(f.root, "other-project"); await mkdir(other);
  const source = { serverId: "features", serverName: "Features", workspacePath: canonical };
  const signal = new AbortController().signal;
  const form = f.mcpInteractions.request("elicitation", source, { mode: "form", message: "Topic", requestedSchema: { type: "object", properties: { topic: { type: "string", minLength: 1 } }, required: ["topic"] } }, signal, { runId: "run-form" });
  const sample = f.mcpInteractions.request("sampling", source, { messages: [], maxTokens: 64 }, signal, { runId: "run-sample" });
  const foreign = f.mcpInteractions.request("elicitation", { ...source, workspacePath: await canonicalMcpProject(other) }, { mode: "url", url: "https://example.test/authorize" }, signal, { runId: "run-other" });
  const alias = join(f.root, ".");
  const listed = await f.rpc("mcp.interactions.list", { workspacePath: alias }) as { requests: Array<{ id: string; runId: string }> };
  expect(listed.requests.map(item => item.runId)).toEqual(["run-form", "run-sample"]);
  expect(await f.rpc("mcp.interactions.list", { workspacePath: alias, runId: "run-sample" })).toMatchObject({ requests: [{ runId: "run-sample" }] });
  const formId = listed.requests.find(item => item.runId === "run-form")!.id;
  const sampleId = listed.requests.find(item => item.runId === "run-sample")!.id;
  await expect(f.rpc("mcp.interactions.respond", { requestId: formId, workspacePath: other, action: "accept", content: { topic: "foreign" } })).rejects.toThrow(/project/);
  for (const content of [{}, { topic: "" }, { topic: "valid", extra: true }]) {
    await expect(f.rpc("mcp.interactions.respond", { requestId: formId, workspacePath: alias, action: "accept", content })).rejects.toThrow(/输入/);
  }
  await expect(f.rpc("mcp.interactions.respond", { requestId: sampleId, workspacePath: alias, action: "accept", content: { replacement: "text" } })).rejects.toThrow(/cannot replace/);
  expect((await f.rpc("mcp.interactions.list", { workspacePath: alias }) as { requests: unknown[] }).requests).toHaveLength(2);
  expect(await f.rpc("mcp.interactions.respond", { requestId: formId, workspacePath: alias, action: "accept", content: { topic: "approved" } })).toEqual({ answered: true });
  expect(await form).toMatchObject({ action: "accept", content: { topic: "approved" }, workspacePath: canonical });
  await expect(f.rpc("mcp.interactions.respond", { requestId: formId, workspacePath: alias, action: "accept", content: { topic: "again" } })).rejects.toThrow(/no longer pending/);
  expect(await f.rpc("mcp.interactions.respond", { requestId: sampleId, workspacePath: alias, action: "decline" })).toEqual({ answered: true });
  expect(await sample).toMatchObject({ action: "decline" });
  const foreignId = (await f.rpc("mcp.interactions.list", { workspacePath: other }) as { requests: Array<{ id: string }> }).requests[0]!.id;
  await expect(f.rpc("mcp.interactions.respond", { requestId: foreignId, workspacePath: other, action: "accept", content: { token: "secret" } })).rejects.toThrow(/does not accept form/);
  await f.rpc("mcp.interactions.respond", { requestId: foreignId, workspacePath: other, action: "cancel" });
  expect(await foreign).toMatchObject({ action: "cancel" });
  expect(await f.rpc("mcp.interactions.list", { workspacePath: alias })).toEqual({ requests: [] });
});

test("OAuth action connects a public MCP server without starting browser authorization", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url)), "public"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); } });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public MCP fixture did not start")), 5000);
    child.stdout.once("data", data => { clearTimeout(timer); resolve(JSON.parse(data.toString()).url); });
  });
  const saved = await f.rpc("mcp.save", { name: "Public", enabled: true, projectPaths: [f.root], transport: { type: "streamable_http", url } }) as { id: string };
  expect(await f.rpc("mcp.auth.start", { serverId: saved.id })).toMatchObject({ state: "not_required" });
  expect(await f.rpc("mcp.list", { workspacePath: f.root })).toMatchObject({ statuses: [{ serverId: saved.id, state: "connected", toolCount: 4 }], auth: { [saved.id]: { state: "signed_out" } } });
}, 15_000);

test("OAuth action opens authorization only after a protected MCP server requests it", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url)), "oauth"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once("exit", () => resolve())); } });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Protected MCP fixture did not start")), 5000);
    child.stdout.once("data", data => { clearTimeout(timer); resolve(JSON.parse(data.toString()).url); });
  });
  const saved = await f.rpc("mcp.save", { name: "Protected", enabled: true, projectPaths: [f.root], transport: { type: "streamable_http", url } }) as { id: string };
  const start = await f.rpc("mcp.auth.start", { serverId: saved.id }) as { state: string; authorizationUrl?: string };
  expect(start.state).toBe("pending");
  expect(start.authorizationUrl).toContain("/authorize?");
  expect(new URL(start.authorizationUrl!).searchParams.get("code_challenge_method")).toBe("S256");
  expect(await f.rpc("mcp.list", { workspacePath: f.root })).toMatchObject({ auth: { [saved.id]: { state: "pending" } } });
}, 15_000);
