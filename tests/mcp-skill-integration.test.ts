import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpService, McpStore, MemoryService, SkillService } from "@harness/extensions";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelRequest, type RunSpec } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { ToolRegistry } from "@harness/tools";
import { createSkillRuntime } from "../packages/core/src/skill-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-skill-")));
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-skill-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const skills = new SkillService(join(root, "global"));
  const path = join(root, ".agent", "skills", "project-status", "SKILL.md");
  await mkdir(join(root, ".agent", "skills", "project-status", "resources"), { recursive: true });
  await writeFile(path, "---\nname: project-status\ndescription: Query project status with MCP\ntools: [echo]\n---\nPROJECT_STATUS_SKILL_RULE: Call the Project service echo tool with value SKILL_MCP_PROOF and use its real result. Read resources/example.txt relative to this skill if needed.");
  await writeFile(join(root, ".agent", "skills", "project-status", "resources", "example.txt"), "SOURCE_RELATIVE_RESOURCE");
  const initial = await skills.load(path);
  const trusted = await skills.load(path, initial.hash); database.saveSkill(trusted.manifest);
  const mcp = new McpService(new McpStore(database));
  await mcp.save({ name: "Project service", enabled: true, projectPaths: [root], readOnlyTools: ["echo"], transport: { type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url))] } });
  cleanups.push(async () => { await mcp.close(); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec: RunSpec = { id: newId("run"), sessionId: "session", profileId: "default", workspacePath: root, request: "Use the project-status skill to report project status", attachments: [], grants: [], budget: { ...DEFAULT_PROFILE.budget, maxTurns: 8 }, createdAt: nowIso(), taskMode: "analysis" };
  return { root, path, database, skills, trusted, mcp, spec };
}
test("trusted skill loading freezes its hash and resolves resources relative to the skill directory", async () => {
  const f = await fixture();
  const runtime = createSkillRuntime({ documents: [f.trusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: [] });
  const context = { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal };
  const loaded = await runtime.tools.find(tool => tool.contract.name === "load_skill")!.execute({ key: f.trusted.key }, context);
  expect(JSON.stringify(loaded)).toContain("PROJECT_STATUS_SKILL_RULE");
  expect(loaded.output).toMatchObject({ missingTools: ["echo"] });
  expect(f.spec.skills).toEqual([{ key: f.trusted.key, hash: f.trusted.hash }]);
  expect(JSON.stringify(runtime.pinned())).toContain("PROJECT_STATUS_SKILL_RULE");
  const read = runtime.tools.find(tool => tool.contract.name === "read_skill_resource")!;
  expect(JSON.stringify(await read.execute({ key: f.trusted.key, path: "resources/example.txt" }, context))).toContain("SOURCE_RELATIVE_RESOURCE");
  await expect(read.execute({ key: f.trusted.key, path: "../../key.json" }, context)).rejects.toThrow();
  await writeFile(f.path, "---\nname: project-status\ndescription: changed\n---\nUNTRUSTED_CHANGED_RULE");
  await expect(runtime.tools.find(tool => tool.contract.name === "load_skill")!.execute({ key: f.trusted.key }, context)).rejects.toThrow(/changed|信任/);
});
test("untrusted skills are absent from discovery and cannot be loaded by guessing their key", async () => {
  const f = await fixture();
  const untrusted = await f.skills.load(f.path);
  const runtime = createSkillRuntime({ documents: [untrusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: [] });
  expect(runtime.catalog).toEqual([]);
  await expect(runtime.tools.find(tool => tool.contract.name === "load_skill")!.execute({ key: untrusted.key }, { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal })).rejects.toThrow();
});
test("a model discovers a trusted project skill, loads it, calls real MCP and uses the result", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      requests.push(request);
      const text = JSON.stringify(request.messages);
      if (requests.length === 1) {
        expect(text).toContain("project-status"); expect(text).not.toContain("PROJECT_STATUS_SKILL_RULE");
        expect(request.tools.some(tool => tool.name === "load_skill")).toBe(true);
        yield { type: "tool_call", toolCall: { id: "load-skill", name: "load_skill", input: { key: f.trusted.key } } };
      } else if (requests.length === 2) {
        expect(text).toContain("PROJECT_STATUS_SKILL_RULE");
        const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"))!;
        yield { type: "tool_call", toolCall: { id: "query-status", name: tool.name, input: { value: "SKILL_MCP_PROOF" } } };
      } else {
        expect(text).toContain("SKILL_MCP_PROOF"); expect(text).toContain('calls');
        yield { type: "text_delta", delta: "Project service returned SKILL_MCP_PROOF; status verified from the actual MCP result." };
      }
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: f.skills, projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  engine.on("event", (event: AgentEvent) => { if (event.type === "approval_required") engine.approvals.decide(event.approvalId, true, "test:user"); });
  const result = new Promise<Extract<AgentEvent, { type: "result" }>>(resolve => { engine.on("event", event => { if (event.type === "result") resolve(event); }); });
  engine.start(f.spec, { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [], skillIds: [] });
  try {
    const final = await result;
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    expect(final.text).toContain("SKILL_MCP_PROOF");
    const event = f.database.listEvents(f.spec.id).find(event => event.type === "tool_finished" && event.callId === "query-status");
    expect(event).toMatchObject({ output: { structuredContent: { calls: 1, arguments: { value: "SKILL_MCP_PROOF" } } } });
    expect(f.database.getRun(f.spec.id)?.spec.skills).toEqual([{ key: f.trusted.key, hash: f.trusted.hash }]);
  } finally { engine.cancel(f.spec.id); }
}, 20_000);
test("same-named global and project skills remain distinct in the catalog", async () => {
  const f = await fixture();
  const globalPath = join(f.root, "global", "project-status", "SKILL.md");
  await mkdir(join(f.root, "global", "project-status"), { recursive: true });
  await writeFile(globalPath, "---\nname: project-status\ndescription: Global variant\n---\nGLOBAL_VARIANT_RULE");
  const globalLoaded = await f.skills.load(globalPath);
  const globalTrusted = await f.skills.load(globalPath, globalLoaded.hash);
  f.database.saveSkill(globalTrusted.manifest);
  const runtime = createSkillRuntime({ documents: [globalTrusted, f.trusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: [] });
  const named = runtime.catalog.filter(entry => entry.name === "project-status");
  expect(named).toHaveLength(2);
  expect(new Set(named.map(entry => entry.source))).toEqual(new Set(["global", "project"]));
  expect(new Set(named.map(entry => entry.key)).size).toBe(2);
});
test("missing tool diagnostics disappear once the tool is available", async () => {
  const f = await fixture();
  const context = { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal };
  const withTool = createSkillRuntime({ documents: [f.trusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: ["echo"] });
  const loaded = await withTool.tools.find(tool => tool.contract.name === "load_skill")!.execute({ key: f.trusted.key }, context);
  expect(loaded.output).toMatchObject({ missingTools: [] });
});
