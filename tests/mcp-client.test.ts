import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { McpServerConfigSchema } from "@harness/protocol";
import { connectMcp, type McpConnection } from "../packages/extensions/src/mcp-client.js";

const fixture = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
let project: string;
const connections: McpConnection[] = [];
const processes: ChildProcess[] = [];
beforeEach(async () => { project = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-client-"))); });
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
  await Promise.all(processes.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill();
  })));
  delete process.env.HARNESS_TEST_PARENT_SECRET;
  await rm(project, { recursive: true, force: true });
});
function config(extra: Record<string, unknown> = {}) {
  return McpServerConfigSchema.parse({ id: "fixture", name: "Fixture", revision: 1, enabled: true, projectPaths: [project], transport: { type: "stdio", command: process.execPath, args: [fixture] }, connectTimeoutMs: 5000, callTimeoutMs: 1000, ...extra });
}
async function remote(mode: string) {
  const child = spawn(process.execPath, [fixture, mode], { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture exited before ready")); });
    child.stdout!.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0]!).url); } });
  });
}
async function open(extra: Record<string, unknown> = {}, onToolsChanged?: () => void) {
  const connection = await connectMcp(config(extra), project, new AbortController().signal, onToolsChanged ? { onToolsChanged } : {});
  connections.push(connection); return connection;
}
test.each(["stdio", "streamable_http", "sse"])("%s enumerates all pages and calls a real server with project roots", async mode => {
  process.env.HARNESS_TEST_PARENT_SECRET = "do-not-inherit";
  const connection = mode === "stdio" ? await open() : await open({ transport: { type: mode, url: await remote(mode) }, headers: { Authorization: "Bearer fixture-token" } });
  expect((await connection.listTools(new AbortController().signal)).map(tool => tool.name)).toEqual(["echo", "slow", "fail", "notify"]);
  const result = await connection.callTool("echo", { value: "hello" }, new AbortController().signal);
  expect(result.structuredContent).toMatchObject({ arguments: { value: "hello" }, cwd: project, roots: [{ uri: pathToFileURL(project).href }], calls: 1 });
  if (mode === "stdio") expect(result.structuredContent?.inheritedSecret).toBeNull();
  expect(await connection.callTool("fail", {}, new AbortController().signal)).toMatchObject({ isError: true });
}, 15_000);
test("cancels timed-out tool requests without replaying writes or losing the connection", async () => {
  const connection = await open({ callTimeoutMs: 100 });
  await expect(connection.callTool("slow", {}, new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
  const result = await connection.callTool("echo", {}, new AbortController().signal);
  expect(result.structuredContent).toMatchObject({ calls: 2, cancelled: 1 });
});
test("caller cancellation and close reject pending calls; close is idempotent", async () => {
  const connection = await open();
  const controller = new AbortController();
  const pending = connection.callTool("slow", {}, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  setTimeout(() => controller.abort(), 50);
  await rejected;
  const next = connection.callTool("slow", {}, new AbortController().signal);
  const closed = expect(next).rejects.toMatchObject({ code: "closed" });
  await connection.close(); await closed; await connection.close();
  expect(connection.closed).toBe(true);
});
test("rejects repeated pagination cursors and receives tool-list notifications", async () => {
  const looping = await open({ env: { FIXTURE_LOOP_CURSOR: "1" } });
  await expect(looping.listTools(new AbortController().signal)).rejects.toMatchObject({ code: "protocol_error" });
  let notifications = 0;
  const connection = await open({}, () => { notifications++; });
  await connection.callTool("notify", {}, new AbortController().signal);
  expect(notifications).toBe(1);
});
test("reports authentication failures without reflecting secrets", async () => {
  await expect(open({ transport: { type: "streamable_http", url: await remote("streamable_http") } })).rejects.toMatchObject({ code: "auth_required", message: "MCP authentication is required" });
});
test("bounds SSE startup even when the HTTP server never sends headers", async () => {
  const start = Date.now();
  await expect(open({ transport: { type: "sse", url: await remote("hang") }, headers: { Authorization: "Bearer fixture-token" }, connectTimeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - start).toBeLessThan(4000);
});
test("rejects disabled and unbound servers before spawning", async () => {
  await expect(open({ enabled: false })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(open({ projectPaths: [] })).rejects.toMatchObject({ code: "not_allowed" });
});
test("a server that repeats a tool name is rejected as a protocol error", async () => {
  const connection = await open({ env: { FIXTURE_DUPLICATE_TOOLS: "1" } });
  await expect(connection.listTools(new AbortController().signal)).rejects.toMatchObject({ code: "protocol_error" });
});
