import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type RunSpec } from "@harness/protocol";
import { ToolRegistry, type ToolDefinition } from "@harness/tools";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });

async function fixture(options: { count?: number; parallelTools?: boolean; browser?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-engine-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  for (const file of ["a", "b", "c"]) await writeFile(join(workspace, `${file}.txt`), file);
  const vault = await VaultCrypto.open(join(root, "key.json"), "tool-concurrency-fixture");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const started: string[] = [];
  const waits = { a: gate(), b: gate(), c: gate() };
  const twoStarted = gate(), threeStarted = gate(), oneStarted = gate();
  const tool: ToolDefinition = {
    ...(options.browser ? {} : { parallelReadScope: "workspace" as const }),
    contract: { name: options.browser ? "browser" : "repository_map", description: "Read an independent fixture source file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 10000 },
    execute: async (input, context) => {
      const id = String(input.path).slice(0, 1) as keyof typeof waits;
      const content = await readFile(join(context.workspacePath, String(input.path)), "utf8");
      started.push(id);
      if (started.length === 1) oneStarted.resolve();
      if (started.length === 2) twoStarted.resolve();
      if (started.length === 3) threeStarted.resolve();
      await waits[id].promise;
      return { output: content };
    },
  };
  const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture", capabilities: { vision: false, tools: true, parallelTools: options.parallelTools ?? true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fixture", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      const firstForRun = !requests.some(previous => previous.runId === request.runId);
      requests.push(structuredClone(request));
      if (firstForRun) for (const id of ["a", "b", "c"].slice(0, options.count ?? 3)) yield { type: "tool_call", toolCall: { id, name: tool.contract.name, input: { path: `${id}.txt` } } };
      else yield { type: "text_delta", delta: "Read the fixture source files and retained the actual evidence." };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry().register(tool), memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database), concurrency: { tools: 2, modelRequests: 2 } });
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fixture"], toolNames: [tool.contract.name], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, items: [], broaderPolicy: "optional" as const } };
  const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Inspect fixture source files", workflowVersion: 2, taskMode: "analysis", workspacePath: workspace, profileId: profile.id, attachments: [], grants: [], budget: { ...profile.budget, maxTurns: 12 }, createdAt: nowIso() };
  database.createSession({ id: spec.sessionId, title: "Tools", workspacePath: workspace, profileId: profile.id, createdAt: nowIso(), updatedAt: nowIso() });
  database.saveRun(spec, "queued");
  const done = new Promise<Extract<AgentEvent, { type: "result" }>>(resolveResult => {
    engine.on("event", (event: AgentEvent) => { events.push(event); if (event.type === "result") resolveResult(event); });
  });
  close.push(async () => {
    for (const wait of Object.values(waits)) wait.resolve();
    await engine.close(); database.close(); vault.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\") && !resolve(root).startsWith(resolve(tmpdir()) + "/")) throw new Error("Fixture cleanup escaped the temporary directory");
    await rm(root, { recursive: true, force: true });
  });
  return { engine, profile, spec, database, requests, events, started, waits, workspace, oneStarted, twoStarted, threeStarted, done, start: () => engine.start(spec, profile) };
}

describe("engine controlled tool execution", { timeout: 20000 }, () => {
  it("serializes shared browser operations across child agents without a workspace lock", async () => {
    const h = await fixture({ count: 1, browser: true });
    const dispatched = gate();
    h.engine.on("event", () => { if (h.events.filter(event => event.type === "tool_started").length === 2) dispatched.resolve(); });
    const children = ["first", "second"].map(id => ({ ...h.spec, id: newId(id), parentRunId: h.spec.id, parentStepId: id }));
    for (const child of children) h.engine.start(child, h.profile);
    await dispatched.promise; await h.oneStarted.promise;
    expect(h.started).toEqual(["a"]);
    h.waits.a.resolve();
    await Promise.all(children.map(child => h.engine.waitForSettlement(child.id)));
    expect(h.started).toEqual(["a", "a"]);
    expect(h.events.filter(event => event.type === "tool_finished")).toHaveLength(2);
  });

  it("actually overlaps trusted reads, refills one slot, and durably records each terminal once", async () => {
    const h = await fixture(); h.start();
    await h.twoStarted.promise;
    expect(h.started.slice().sort()).toEqual(["a", "b"]);
    h.waits.b.resolve(); await h.threeStarted.promise;
    expect(h.started.slice().sort()).toEqual(["a", "b", "c"]);
    h.waits.c.resolve(); h.waits.a.resolve(); await h.done;
    const finished = h.events.filter(event => event.type === "tool_finished");
    expect(finished.map(event => event.callId).sort()).toEqual(["a", "b", "c"]);
    const results = h.requests[1]!.messages.flatMap(message => message.content.flatMap(part => part.type === "tool_result" ? [part.toolCallId] : []));
    expect(results).toEqual(["a", "b", "c"]);
    const checkpoint = h.database.getLatestCheckpoint(h.spec.id)!;
    expect(checkpoint.workflow?.observations.filter(item => ["a", "b", "c"].includes(item.id)).map(item => item.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("marks source evidence incomplete when workspace contents change during a read", async () => {
    const h = await fixture({ count: 1 }); h.start();
    await h.oneStarted.promise;
    await writeFile(join(h.workspace, "a.txt"), "changed by a concurrent external editor");
    h.waits.a.resolve(); await h.done;
    const finished = h.events.find(event => event.type === "tool_finished" && event.callId === "a");
    expect(finished).toMatchObject({ output: { stale: true } });
    const observation = h.database.getLatestCheckpoint(h.spec.id)!.workflow!.observations.find(item => item.id === "a");
    expect(observation?.complete).toBe(false);
  });

  it("blocks parent tools while a child owns the same workspace for writes", async () => {
    const h = await fixture({ count: 1 });
    const writerStarted = gate(), writerRelease = gate();
    const writer = h.engine.withConversationWorkspace(h.spec.id, "write", async () => { writerStarted.resolve(); await writerRelease.promise; });
    await writerStarted.promise;
    h.start();
    // The model can issue a tool call, but the started event must wait for the actual resource.
    while (!h.requests.length) await new Promise<void>(done => setImmediate(done));
    expect(h.events.filter(event => event.type === "tool_started")).toHaveLength(0);
    writerRelease.resolve(); await writer; await h.oneStarted.promise;
    h.waits.a.resolve(); await h.done;
    expect(h.events.filter(event => event.type === "tool_started")).toHaveLength(1);
  });

  it("uses the model capability fallback for actual engine tools", async () => {
    const h = await fixture({ parallelTools: false }); h.start();
    await h.oneStarted.promise;
    expect(h.started).toEqual(["a"]);
    expect(h.requests[0]!.parallelToolCalls).toBe(false);
    h.waits.a.resolve(); await h.twoStarted.promise; h.waits.b.resolve();
    await h.threeStarted.promise; h.waits.c.resolve(); await h.done;
  });

  it("retains exactly one terminal when the start checkpoint fails before I/O", async () => {
    const h = await fixture({ count: 1 });
    let failed = false;
    h.engine.on("event", (event: AgentEvent) => {
      if (failed || event.type !== "tool_started") return;
      failed = true;
      const save = h.database.saveCheckpoint.bind(h.database);
      h.database.saveCheckpoint = (...args) => {
        h.database.saveCheckpoint = save;
        throw new Error(`fixture storage failure before ${args[0].reason}`);
      };
    });
    h.start(); await h.done;
    expect(h.started).toEqual([]);
    expect(h.events.filter(event => event.type === "tool_started")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "tool_finished")).toMatchObject([{ callId: "a", isError: true }]);
  });

  it("retains exactly one terminal for an aborted started read", async () => {
    const h = await fixture({ count: 1 }); h.start();
    await h.oneStarted.promise;
    h.engine.cancel(h.spec.id);
    h.waits.a.resolve(); await h.done;
    expect(h.events.filter(event => event.type === "tool_started")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "tool_finished")).toMatchObject([{ callId: "a", isError: true }]);
  });
});
