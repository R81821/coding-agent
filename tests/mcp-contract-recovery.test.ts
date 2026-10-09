import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { McpConnection, McpService } from "@harness/extensions";
import { DEFAULT_PROFILE, McpServerConfigSchema, newId, nowIso, type RunSpec } from "@harness/protocol";
import { prepareMcpCapabilities, type RunCapabilityLease } from "../packages/core/src/mcp-capabilities.js";

const cleanups: Array<() => Promise<void>> = [];
type Tool = Awaited<ReturnType<McpConnection["listTools"]>>[number];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-mcp-contract-recovery-"));
  const leases: RunCapabilityLease[] = [];
  cleanups.push(async () => { await Promise.all(leases.map(lease => lease.close())); await rm(root, { recursive: true, force: true }); });
  const server = McpServerConfigSchema.parse({ id: "mutable-server", name: "Project service", revision: 1, enabled: true, projectPaths: [root], transport: { type: "stdio", command: process.execPath }, readOnlyTools: ["echo"] });
  let remoteTools: Tool[] = [
    { name: "echo", description: "Echo project status", inputSchema: { type: "object", properties: { value: { type: "string", description: "Project value" } }, required: ["value"], additionalProperties: false } },
    { name: "write", description: "Write project status", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
  ];
  const callTool = vi.fn(async (_name: string, input: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(input) }] }));
  const service = {
    store: { list: () => [server] }, secretValues: async () => [],
    acquire: async () => {
      let closed = false;
      return {
        connection: { get closed() { return closed; }, listTools: async () => structuredClone(remoteTools), callTool },
        close: async () => { closed = true; },
      };
    },
  } as unknown as McpService;
  const spec: RunSpec = { id: newId("run"), sessionId: "session", profileId: "default", workspacePath: root, request: "Optimize rain animation", attachments: [], budget: { ...DEFAULT_PROFILE.budget }, grants: [], createdAt: nowIso() };
  const context = { runId: spec.id, workspacePath: root, grants: [], signal: new AbortController().signal };
  async function prepare(signal = context.signal) {
    const lease = await prepareMcpCapabilities(service, spec, signal); leases.push(lease); return lease;
  }
  async function freeze() {
    const lease = await prepare(); spec.mcpSnapshot = structuredClone(lease.snapshot); await lease.close(); return lease;
  }
  return { root, server, spec, context, callTool, prepare, freeze, tools: () => remoteTools, replace: (tools: Tool[]) => { remoteTools = tools; } };
}

test("resume keeps frozen descriptions and schemas when only annotations and JSON key order change", async () => {
  const f = await fixture();
  const frozen = await f.freeze();
  const echo = f.tools()[0]!;
  echo.description = "A newly worded description that the run must not adopt";
  echo.inputSchema = { additionalProperties: false, required: ["value"], properties: { value: { description: "New annotation", title: "Value", examples: ["sample"], type: "string" } }, $comment: "New schema comment", type: "object" };
  const recovered = await f.prepare();
  expect(recovered.diagnostics).toEqual([]);
  const tool = recovered.tools.find(item => item.external?.toolName === "echo")!;
  const original = frozen.tools.find(item => item.external?.toolName === "echo")!;
  expect(tool.contract.description).toBe(original.contract.description);
  expect(tool.contract.inputSchema).toEqual(original.contract.inputSchema);
  expect(recovered.snapshot[0]!.contractHash).not.toBe(frozen.snapshot[0]!.contractHash);
  expect(recovered.snapshot[0]!.semanticContractHash).toBe(frozen.snapshot[0]!.semanticContractHash);
  expect(tool.requiresApproval).toBe(true);
  await tool.execute({ value: "project status" }, f.context);
  expect(f.callTool).toHaveBeenCalledTimes(1);
  await expect(tool.execute({ value: 42 }, f.context)).rejects.toThrow(/Invalid MCP tool arguments/);
  expect(f.callTool).toHaveBeenCalledTimes(1);
});

test.each(["input", "output", "risk"])("resume quarantines genuine %s changes while preserving unchanged tools", async changed => {
  const f = await fixture(); await f.freeze();
  if (changed === "input") f.tools()[0]!.inputSchema.properties = { value: { type: "number" } };
  if (changed === "output") f.tools()[0]!.outputSchema = { type: "object", properties: { status: { type: "boolean" } } };
  if (changed === "risk") f.server.readOnlyTools = [];
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["write"]);
  expect(recovered.diagnostics).toHaveLength(1);
  expect(recovered.diagnostics[0]?.error).toMatch(/contract changed.*echo.*withheld/);
  expect(recovered.resolve({ id: "drifted", name: f.spec.mcpSnapshot![0]!.name, input: { value: "status" } })).toBeUndefined();
  expect(f.callTool).not.toHaveBeenCalled();
});

test("legacy snapshots cannot infer that a changed hash is harmless and quarantine it without failing recovery", async () => {
  const f = await fixture(); await f.freeze();
  f.spec.mcpSnapshot = f.spec.mcpSnapshot!.map(({ serverId, revision, toolName, name, contractHash, risk }) => ({ serverId, revision, toolName, name, contractHash, risk }));
  f.tools()[0]!.description = "Different presentation, but no saved semantic hash";
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["write"]);
  expect(recovered.diagnostics[0]?.error).toMatch(/contract changed.*withheld/);
  expect(f.callTool).not.toHaveBeenCalled();
});

test("legacy snapshots with identical contracts recover with normal validation and approval", async () => {
  const f = await fixture(); await f.freeze();
  f.spec.mcpSnapshot = f.spec.mcpSnapshot!.map(({ serverId, revision, toolName, name, contractHash, risk }) => ({ serverId, revision, toolName, name, contractHash, risk }));
  const recovered = await f.prepare();
  expect(recovered.diagnostics).toEqual([]);
  expect(recovered.tools).toHaveLength(2);
  expect(recovered.tools.every(tool => tool.requiresApproval)).toBe(true);
});

test("a changed server configuration is withheld rather than adopted during resume", async () => {
  const f = await fixture(); await f.freeze(); f.server.revision++;
  const recovered = await f.prepare();
  expect(recovered.tools).toEqual([]);
  expect(recovered.diagnostics[0]?.error).toMatch(/configuration changed.*withheld/);
  expect(f.callTool).not.toHaveBeenCalled();
});

test("removed frozen tools are reported and newly advertised tools cannot widen the run", async () => {
  const f = await fixture(); await f.freeze();
  f.replace([f.tools()[1]!, { name: "new-write", inputSchema: { type: "object" } }]);
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["write"]);
  expect(recovered.diagnostics[0]?.error).toMatch(/catalog changed.*echo.*withheld/);
  expect(recovered.snapshot.some(tool => tool.toolName === "new-write")).toBe(false);
});

test("execute rechecks semantic contracts without adopting refreshed descriptions", async () => {
  const f = await fixture(); const lease = await f.prepare();
  const tool = lease.tools.find(item => item.external?.toolName === "echo")!;
  const original = tool.contract.description;
  f.tools()[0]!.description = "New live wording";
  f.tools()[0]!.inputSchema.title = "New title";
  await tool.execute({ value: "safe" }, f.context);
  expect(f.callTool).toHaveBeenCalledTimes(1);
  expect(tool.contract.description).toBe(original);
  f.tools()[0]!.inputSchema.required = ["value", "extra"];
  await expect(tool.execute({ value: "blocked" }, f.context)).rejects.toThrow(/contract changed.*not sent/);
  expect(f.callTool).toHaveBeenCalledTimes(1);
  expect(f.spec.mcpUncertainCalls).toEqual([]);
});

test("description keys inside schema literals are validation data and must not be ignored", async () => {
  const f = await fixture();
  f.tools()[0]!.inputSchema = { type: "object", properties: { value: { const: { description: "expected literal" } } }, required: ["value"] };
  await f.freeze();
  f.tools()[0]!.inputSchema.properties = { value: { const: { description: "changed literal" } } };
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["write"]);
  expect(recovered.diagnostics[0]?.error).toMatch(/contract changed/);
});

test("references into annotation objects retain exact validation semantics", async () => {
  const f = await fixture();
  f.tools()[0]!.inputSchema = { type: "object", properties: { value: { $ref: "#/examples/0" } }, examples: [{ type: "string" }], required: ["value"] };
  await f.freeze();
  f.tools()[0]!.inputSchema.examples = [{ type: "number" }];
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["write"]);
  expect(recovered.diagnostics[0]?.error).toMatch(/contract changed/);
  expect(f.callTool).not.toHaveBeenCalled();
});

test("read-only narrowing on resume neither widens the catalog nor reports intentional removals", async () => {
  const f = await fixture(); await f.freeze(); f.spec.mcpReadOnly = true;
  const recovered = await f.prepare();
  expect(recovered.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
  expect(recovered.diagnostics).toEqual([]);
  expect(recovered.tools.every(tool => tool.contract.risk === "read")).toBe(true);
});

test("an aborted recovery remains aborted instead of degrading to an availability diagnostic", async () => {
  const f = await fixture(); await f.freeze();
  const controller = new AbortController(); controller.abort(new Error("Cancelled by the user"));
  await expect(f.prepare(controller.signal)).rejects.toThrow(/Cancelled by the user/);
});
