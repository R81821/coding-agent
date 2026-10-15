import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { McpService, McpStore, MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, latestContextUsage, newId, nowIso, type AgentEvent, type McpInteractionView, type ModelRequest, type RunSpec } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";
import { ToolRegistry } from "@harness/tools";

const serverFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-features-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture(operation: "sample" | "form" | "url", maxTurns = 8) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-interaction-runtime-")));
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-interaction-runtime-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const mcp = new McpService(new McpStore(database));
  const server = await mcp.save({ name: "Interaction fixture", enabled: true, projectPaths: [root],
    transport: { type: "stdio", command: process.execPath, args: [serverFile] }, readOnlyTools: ["sample", "form", "url"], callTimeoutMs: 15_000 });
  const requests: ModelRequest[] = [];
  let mainRequests = 0;
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "interaction-model", displayName: "Fixture model", capabilities: {
      vision: true, tools: true, parallelTools: false, structuredOutput: false, maxContextTokens: 1_000_000, maxOutputTokens: 4_096, dataPolicy: "local",
    } })],
    async *stream(request) {
      requests.push(request);
      if (request.purpose === "sampling") {
        yield { type: "text_delta", delta: "Sampled fixture response" };
        yield { type: "usage", usage: { inputTokens: 47, outputTokens: 8, estimatedUsd: 0.012, costKnown: true } };
      } else if (++mainRequests === 1) {
        const tool = request.tools.find(candidate => candidate.description.includes(`[Interaction fixture / ${operation}]`));
        if (!tool) throw new Error(`MCP ${operation} tool unavailable`);
        yield { type: "usage", usage: { inputTokens: 5_000, outputTokens: 24, estimatedUsd: 0, costKnown: true } };
        yield { type: "tool_call", toolCall: { id: `invoke-${operation}`, name: tool.name, input: {} } };
      } else {
        yield { type: "text_delta", delta: "Fixture task finished." };
        yield { type: "usage", usage: { inputTokens: 5_500, outputTokens: 45, estimatedUsd: 0, costKnown: true } };
      }
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database),
    skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database), mcp });
  cleanups.push(async () => { await engine.close(); await mcp.close(); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec: RunSpec = { id: newId("run"), sessionId: "fixture-session", profileId: "default", workspacePath: root,
    request: "Use the interaction fixture. Private host task marker: HOST_HISTORY_SECRET", attachments: [],
    budget: { ...DEFAULT_PROFILE.budget, maxTurns, maxToolCalls: 6 }, grants: [], createdAt: nowIso(), taskMode: "analysis" };
  const events: AgentEvent[] = [];
  let approvals = 0;
  engine.on("event", (event: AgentEvent) => {
    events.push(event);
    if (event.type === "approval_required") { approvals++; engine.approvals.decide(event.approvalId, true, "test:user"); }
  });
  const settled = async () => {
    const final = await until(() => events.find(event => event.type === "result"), "run result");
    await until(() => engine.isActive(spec.id) ? undefined : true, "run lease settlement");
    return final;
  };
  const pending = () => until<McpInteractionView>(() => engine.mcpInteractions.list(root, spec.id)[0], "MCP reverse request");
  const start = () => engine.start(spec, { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] });
  return { root, database, mcp, server, engine, spec, requests, events, settled, pending, start, approvals: () => approvals };
}

test.each(["accept", "decline"] as const)("real MCP sampling %s runs the selected model only after the user decision", async action => {
  const f = await fixture("sample"); f.start();
  const pending = await f.pending();
  expect(pending).toMatchObject({ kind: "sampling", runId: f.spec.id, serverId: f.server.id, serverName: "Interaction fixture", modelName: "Fixture model" });
  expect(f.requests.filter(request => request.purpose === "sampling")).toEqual([]);
  expect(f.engine.mcpInteractions.list(f.root, "different-run")).toEqual([]);
  f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action });
  expect(await f.settled()).not.toMatchObject({ status: "failed" });
  expect(f.approvals()).toBe(1);
  const sampling = f.requests.filter(request => request.purpose === "sampling");
  expect(sampling).toHaveLength(action === "accept" ? 1 : 0);
  expect(f.engine.mcpInteractions.list(f.root)).toEqual([]);
  const sampleUsages = f.events.filter(event => event.type === "usage" && event.usage.purpose === "sampling");
  expect(sampleUsages).toHaveLength(action === "accept" ? 1 : 0);
  if (action === "accept") {
    expect(sampling[0]).toMatchObject({ maxOutputTokens: 64, tools: [], store: false });
    expect(JSON.stringify(sampling[0]!.messages)).toContain("Fixture sampling request");
    expect(JSON.stringify(sampling[0]!.messages)).toContain("Fixture system prompt");
    expect(JSON.stringify(sampling[0]!.messages)).not.toContain("HOST_HISTORY_SECRET");
    expect(sampling[0]!.messages.filter(message => message.role === "system").some(message => JSON.stringify(message).includes("Fixture system prompt"))).toBe(false);
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("Sampled fixture response");
    expect(sampleUsages[0]).toMatchObject({ usage: { inputTokens: 47, outputTokens: 8, estimatedUsd: 0.012, purpose: "sampling" } });
    expect(f.events.filter(event => event.type === "model_request_finished" && event.purpose === "sampling")).toEqual([expect.objectContaining({ succeeded: true })]);
    const throughSample = f.events.slice(0, f.events.indexOf(sampleUsages[0]!) + 1);
    const withoutSample = throughSample.filter(event => event.type !== "usage" || event.usage.purpose !== "sampling");
    expect(latestContextUsage(throughSample, { preserveMeasurements: true })).toEqual(latestContextUsage(withoutSample, { preserveMeasurements: true }));
    expect(latestContextUsage(throughSample, { preserveMeasurements: true })?.usedTokens).toBeGreaterThanOrEqual(5_024);
    expect(f.database.getLatestCheckpoint(f.spec.id)?.usage.estimatedUsd).toBeCloseTo(0.012);
  } else {
    expect(f.events.filter(event => event.type === "model_request_finished" && event.purpose === "sampling")).toEqual([]);
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain("Sampled fixture response");
  }
}, 20_000);

test("real MCP form elicitation validates input then returns the user content to the server and model", async () => {
  const f = await fixture("form"); f.start();
  const pending = await f.pending();
  expect(pending).toMatchObject({ kind: "elicitation", params: { mode: "form", requestedSchema: { required: ["topic"] } } });
  expect(() => f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action: "accept", content: {} })).toThrow();
  expect(f.engine.mcpInteractions.list(f.root, f.spec.id)).toHaveLength(1);
  f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action: "accept", content: { topic: "Validated user topic" } });
  expect(await f.settled()).not.toMatchObject({ status: "failed" });
  expect(f.requests.filter(request => request.purpose === "sampling")).toEqual([]);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("Validated user topic");
  expect(JSON.stringify(f.events.filter(event => event.type === "tool_finished"))).toContain('"action":"accept"');
  expect(f.engine.mcpInteractions.list(f.root)).toEqual([]);
}, 20_000);

test("real MCP URL elicitation returns cancellation without starting a model request", async () => {
  const f = await fixture("url"); f.start();
  const pending = await f.pending();
  expect(pending).toMatchObject({ kind: "elicitation", params: { mode: "url", url: "https://example.test/authorize", elicitationId: "fixture-auth" } });
  f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action: "cancel" });
  expect(await f.settled()).not.toMatchObject({ status: "failed" });
  const toolResult = f.events.find(event => event.type === "tool_finished");
  expect(toolResult).toMatchObject({ output: { structuredContent: { action: "cancel" } } });
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("cancel");
  expect(f.requests.filter(request => request.purpose === "sampling")).toEqual([]);
}, 20_000);

test.each(["sample", "form"] as const)("pausing a run cancels the real MCP %s decision and settles the run", async operation => {
  const f = await fixture(operation); f.start();
  const pending = await f.pending();
  expect(f.engine.pause(f.spec.id)).toBe(true);
  expect(f.engine.mcpInteractions.list(f.root)).toEqual([]);
  expect(() => f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action: "accept" })).toThrow(/no longer pending/);
  expect(await f.settled()).toMatchObject({ status: "paused" });
  expect(f.requests.filter(request => request.purpose === "sampling")).toEqual([]);
  expect(f.database.getRun(f.spec.id)?.status).toBe("paused");
  expect(f.database.getLatestCheckpoint(f.spec.id)).toBeDefined();
}, 20_000);

test("approved real MCP sampling respects the host model turn budget before starting generation", async () => {
  const f = await fixture("sample", 1); f.start();
  const pending = await f.pending();
  f.engine.mcpInteractions.respond({ requestId: pending.id, workspacePath: f.root, action: "accept" });
  expect(await f.settled()).toMatchObject({ status: "review" });
  expect(f.requests.filter(request => request.purpose === "sampling")).toEqual([]);
  expect(f.engine.mcpInteractions.list(f.root)).toEqual([]);
}, 20_000);
