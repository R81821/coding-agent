import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpService, McpStore, MemoryService, SkillService } from "@harness/extensions";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type RunSpec } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { ToolRegistry } from "@harness/tools";
import { mcpToolName, prepareMcpCapabilities } from "../packages/core/src/mcp-capabilities.js";

const serverFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-runtime-")));
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-runtime-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const mcp = new McpService(new McpStore(database));
  cleanups.push(async () => {
    await mcp.close(); database.close(); vault.dispose();
    const target = relative(await realpath(tmpdir()), root);
    if (!target || target.startsWith("..") || isAbsolute(target)) throw new Error("Unsafe MCP fixture cleanup target");
    // Windows may release a stdio server's cwd a moment after its transport closes.
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const server = await mcp.save({ name: "Project service", transport: { type: "stdio", command: process.execPath, args: [serverFile] }, enabled: true, projectPaths: [root], readOnlyTools: ["echo"] });
  const spec: RunSpec = { id: newId("run"), sessionId: "session", profileId: "default", workspacePath: root, request: "Read project service status", attachments: [], budget: { ...DEFAULT_PROFILE.budget, maxTurns: 6, maxToolCalls: 6 }, grants: [], createdAt: nowIso(), taskMode: "analysis" };
  return { root, vault, database, mcp, server, spec };
}
test("runtime namespaces remote names and classifies tools from local policy, not server hints", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, id: undefined, expectedRevision: undefined, name: "Another service" });
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    const echo = lease.tools.filter(tool => tool.external?.toolName === "echo");
    expect(echo).toHaveLength(2); expect(new Set(echo.map(tool => tool.contract.name)).size).toBe(2);
    expect(echo.every(tool => /^[a-z][a-z0-9_]{1,63}$/.test(tool.contract.name) && tool.contract.risk === "read" && tool.requiresApproval)).toBe(true);
    expect(lease.tools.find(tool => tool.external?.toolName === "fail")?.contract.risk).toBe("high");
    expect(lease.snapshot).toHaveLength(8);
  } finally { await lease.close(); }
});
test("recovery withholds changed server revisions and returns an availability diagnostic", async () => {
  const f = await fixture();
  const first = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  f.spec.mcpSnapshot = first.snapshot; await first.close();
  await f.mcp.save({ ...f.server, expectedRevision: f.server.revision, name: "Changed" });
  const recovered = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(recovered.tools).toEqual([]);
    expect(recovered.diagnostics).toHaveLength(1);
    expect(recovered.diagnostics[0]?.error).toMatch(/MCP configuration changed.*withheld/);
  } finally { await recovered.close(); }
});
test("large catalogs expose search and dispatch while retaining the actual permission metadata and schema", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, expectedRevision: 1, env: { FIXTURE_TOOL_COUNT: "60" }, readOnlyTools: ["echo_2"] });
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.contract.name)).toEqual(["mcp_search", "mcp_call"]);
    const match = lease.snapshot.find(tool => tool.toolName === "echo_2")!;
    const resolved = lease.resolve({ id: "proxy", name: "mcp_call", input: { tool: match.name, arguments: { value: 42 } } })!;
    expect(resolved.tool.requiresApproval).toBe(true); expect(resolved.tool.contract.risk).toBe("read");
    await expect(resolved.tool.execute(resolved.call.input, { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal })).rejects.toThrow(/arguments/);
  } finally { await lease.close(); }
});
test("invalid JSON schemas are rejected before exposing server tools", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, expectedRevision: 1, env: { FIXTURE_BAD_SCHEMA: "1" } });
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try { expect(lease.tools).toEqual([]); expect(lease.diagnostics).toHaveLength(1); } finally { await lease.close(); }
});
test("uncertain writes cannot be repeated and their fingerprint survives capability preparation", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, expectedRevision: 1, callTimeoutMs: 100 });
  let lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const context = { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal };
  try {
    const tool = lease.tools.find(tool => tool.external?.toolName === "slow")!;
    await expect(tool.execute({}, context)).rejects.toMatchObject({ code: "mcp_outcome_unknown" });
    expect(f.spec.mcpUncertainCalls).toHaveLength(1);
    await expect(tool.execute({}, context)).rejects.toThrow(/not replayed/);
    f.spec.mcpSnapshot = lease.snapshot; await lease.close();
    lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
    await expect(lease.tools.find(tool => tool.external?.toolName === "slow")!.execute({}, context)).rejects.toThrow(/not replayed/);
  } finally { await lease.close(); }
});
test("binary results become encrypted attachments while resource links keep their type", async () => {
  const f = await fixture();
  const blobs = new EncryptedBlobStore(join(f.root, "blobs"), f.vault);
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal, { blobs, database: f.database });
  try {
    const result = await lease.tools.find(tool => tool.external?.toolName === "echo")!.execute({ value: "fixture-media" }, { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal });
    const content = (result.output as { content: Array<{ type: string; attachment?: { id: string }; uri?: string }> }).content;
    expect(content.map(item => item.type)).toEqual(["image", "audio", "resource_link"]);
    expect(content[0]?.attachment?.id).toBeTruthy(); expect(content[2]?.uri).toBe("https://example.test/result");
    expect(JSON.stringify(result.output)).not.toContain(Buffer.from("fixture-image-data").toString("base64"));
  } finally { await lease.close(); }
});
test.each([true, false])("engine actually invokes a project MCP tool only after approval=%s", async approved => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"));
        if (!tool) throw new Error("MCP tool was not exposed to the model");
        yield { type: "tool_call", toolCall: { id: "external-echo", name: tool.name, input: { value: "from-project-task" } } };
      } else yield { type: "text_delta", delta: approved ? "Project service responded." : "Permission was denied." };
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  let approvals = 0;
  engine.on("event", (event: AgentEvent) => { if (event.type === "approval_required") { approvals++; engine.approvals.decide(event.approvalId, approved, "test:user"); } });
  const result = new Promise<AgentEvent>(resolve => { engine.on("event", event => { if (event.type === "result") resolve(event); }); });
  engine.start(f.spec, { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] });
  try {
    const final = await result;
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    expect(final).not.toMatchObject({ status: "failed" });
    expect(approvals).toBe(1);
    const events = f.database.listEvents(f.spec.id);
    const finished = events.filter(event => event.type === "tool_finished");
    expect(finished).toHaveLength(approved ? 1 : 0);
    if (approved) {
      expect(JSON.stringify(finished)).toContain("from-project-task");
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("from-project-task");
    }
    expect(f.database.getRun(f.spec.id)?.spec.mcpSnapshot?.length).toBeGreaterThan(0);
    expect((await f.mcp.statuses(f.root))[0]?.state).toBe("disconnected");
  } finally { engine.cancel(f.spec.id); }
}, 20_000);

test("engine shutdown cancels pending MCP approval and waits for the run lease and checkpoint", async () => {
  const f = await fixture();
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"))!;
      yield { type: "tool_call", toolCall: { id: "pending-external", name: tool.name, input: { value: "never-authorized" } } };
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  const pending = new Promise<string>(resolve => engine.on("event", (event: AgentEvent) => {
    if (event.type === "approval_required") resolve(event.approvalId);
  }));
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
  engine.start(f.spec, profile);
  const approvalId = await pending;
  try {
    await engine.close();
    expect(engine.isActive(f.spec.id)).toBe(false);
    expect(f.database.getApproval(approvalId)?.status).toBe("denied");
    expect(f.database.getRun(f.spec.id)?.status).toBe("cancelled");
    expect(f.database.getLatestCheckpoint(f.spec.id)).toBeDefined();
    expect(f.database.listEvents(f.spec.id).filter(event => event.type === "tool_finished")).toEqual([]);
    expect((await f.mcp.statuses(f.root))[0]?.state).toBe("disconnected");
    expect(() => engine.start({ ...f.spec, id: "late-run" }, profile)).toThrow(/closed/i);
    expect(() => engine.resume(f.spec.id, profile)).toThrow(/closed/i);
    await engine.close();
  } finally {
    engine.cancel(f.spec.id);
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
  }
}, 20_000);

test("a read-only run exposes only read tools", async () => {
  const f = await fixture();
  f.spec.mcpReadOnly = true;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
    expect(lease.tools.every(tool => tool.contract.risk === "read")).toBe(true);
    expect(lease.snapshot).toHaveLength(1);
  } finally { await lease.close(); }
});

test("read-only narrowing on recovery is not misreported as a catalog change", async () => {
  const f = await fixture();
  const first = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  expect(first.snapshot).toHaveLength(4);
  f.spec.mcpSnapshot = first.snapshot;
  await first.close();
  f.spec.mcpReadOnly = true;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
    expect(lease.snapshot).toHaveLength(1);
  } finally { await lease.close(); }
});

test("a frozen read tool that the server no longer provides is unavailable on recovery", async () => {
  const f = await fixture();
  // Hand-craft the frozen snapshot so the revision still matches while a read tool is missing.
  f.spec.mcpSnapshot = [{ serverId: f.server.id, revision: f.server.revision, toolName: "ghost", name: mcpToolName(f.server.id, "ghost"), contractHash: "ghost", risk: "read" }];
  f.spec.mcpReadOnly = true;
  const recovered = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(recovered.tools).toEqual([]);
    expect(recovered.resolve({ id: "ghost-call", name: mcpToolName(f.server.id, "ghost"), input: {} })).toBeUndefined();
    expect(recovered.diagnostics[0]?.error).toMatch(/MCP tool catalog changed.*withheld/);
  } finally { await recovered.close(); }
});

test("a delegated child inherits its parent catalog and cannot widen it", async () => {
  const f = await fixture();
  const second = await f.mcp.save({ ...f.server, id: undefined, expectedRevision: undefined, name: "Another service" });
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  expect(parent.snapshot).toHaveLength(8);
  const inherited = parent.snapshot.filter(tool => tool.serverId === second.id);
  await parent.close();
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.snapshot).toHaveLength(4);
    expect(lease.snapshot.every(tool => tool.serverId === second.id)).toBe(true);
  } finally { await lease.close(); }
});

test("a read-only child cannot receive write tools even when its parent had them", async () => {
  const f = await fixture();
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const inherited = parent.snapshot;
  expect(inherited.some(tool => tool.risk === "high")).toBe(true);
  await parent.close();
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited, mcpReadOnly: true };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
    expect(lease.tools.every(tool => tool.contract.risk === "read")).toBe(true);
  } finally { await lease.close(); }
});

test("a server updated since the parent run degrades to a diagnostic instead of failing the child", async () => {
  const f = await fixture();
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const inherited = parent.snapshot;
  await parent.close();
  await f.mcp.save({ ...f.server, expectedRevision: f.server.revision, name: "Changed" });
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.snapshot).toHaveLength(0);
    expect(lease.tools).toEqual([]);
    expect(lease.diagnostics).toHaveLength(1);
    expect(lease.diagnostics[0]?.error).toMatch(/revision changed/);
  } finally { await lease.close(); }
});

test("prior takes precedence over inherited when both are present", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, id: undefined, expectedRevision: undefined, name: "Another service" });
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const both = parent.snapshot;
  expect(both).toHaveLength(8);
  const onlyFirst = both.filter(tool => tool.serverId === f.server.id);
  await parent.close();
  // prior freezes to the first server only while inherited offers both: prior must win.
  f.spec.mcpSnapshot = onlyFirst;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal, { inherited: both });
  try {
    expect(lease.snapshot).toHaveLength(4);
    expect(lease.snapshot.every(tool => tool.serverId === f.server.id)).toBe(true);
  } finally { await lease.close(); }
});

test("a read-only child with a large catalog still sees only read tools", async () => {
  const f = await fixture();
  await f.mcp.save({ ...f.server, expectedRevision: 1, env: { FIXTURE_TOOL_COUNT: "60" }, readOnlyTools: Array.from({ length: 60 }, (_, index) => `echo_${index}`) });
  f.spec.mcpReadOnly = true;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.contract.name)).toEqual(["mcp_search", "mcp_call"]);
    expect(lease.tools.every(tool => tool.contract.risk === "read")).toBe(true);
  } finally { await lease.close(); }
});

test("the engine reports MCP tool origin and resolved capabilities to the UI stream", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      requests.push(request);
      // Only the first turn calls the tool; otherwise the run loops until its turn budget.
      if (requests.length === 1) {
        const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"));
        if (tool) yield { type: "tool_call", toolCall: { id: "origin-echo", name: tool.name, input: { value: "origin-probe" } } };
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  engine.on("event", (event: AgentEvent) => { if (event.type === "approval_required") engine.approvals.decide(event.approvalId, true, "test:user"); });
  const result = new Promise<AgentEvent>(resolve => { engine.on("event", event => { if (event.type === "result") resolve(event); }); });
  engine.start(f.spec, { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] });
  try {
    await result;
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    const events = f.database.listEvents(f.spec.id);
    expect(events.filter(event => event.type === "tool_started")).toHaveLength(1);
    const started = events.find(event => event.type === "tool_started");
    expect(started?.origin).toMatchObject({ serverName: "Project service", toolName: "echo" });
    expect(started?.origin?.serverId).toBe(f.server.id);
    const resolved = events.find(event => event.type === "capabilities_resolved");
    expect(resolved?.mcp.length).toBeGreaterThan(0);
    expect(resolved?.skills).toEqual([]);
    expect(resolved?.diagnostics).toEqual([]);
  } finally { engine.cancel(f.spec.id); }
}, 20_000);

test("a resumed run does not re-emit capabilities_resolved", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      requests.push(request);
      // Only the first run calls the tool; the resumed run just answers.
      if (requests.length === 1) {
        const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"));
        if (tool) yield { type: "tool_call", toolCall: { id: "resume-echo", name: tool.name, input: { value: "resume-probe" } } };
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  engine.on("event", (event: AgentEvent) => {
    if (event.type === "approval_required") engine.approvals.decide(event.approvalId, true, "test:user");
    if (event.type === "tool_finished" && event.callId === "resume-echo") engine.pause(f.spec.id);
  });
  const results: AgentEvent[] = [];
  engine.on("event", event => { if (event.type === "result") results.push(event); });
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
  engine.start(f.spec, profile);
  try {
    while (results.length < 1) await new Promise(resolve => setTimeout(resolve, 10));
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    expect(results[0]).toMatchObject({ type: "result", status: "paused" });
    engine.resume(f.spec.id, profile);
    while (results.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    const events = f.database.listEvents(f.spec.id);
    expect(events.filter(event => event.type === "recovery_event")).toHaveLength(1);
    expect(events.filter(event => event.type === "capabilities_resolved")).toHaveLength(1);
    expect(results[1]).toMatchObject({ type: "result", status: "completed" });
  } finally { await engine.close(); }
}, 20_000);
