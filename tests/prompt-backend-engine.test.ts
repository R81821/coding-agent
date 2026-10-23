import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { createConfiguredProviders, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ModelMessage, type ModelRequest, type Profile, type PromptBackendSelection, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";
import { loadProviderSettings, providerSettingsEnvironment, saveProviderSettings } from "../apps/desktop/src/provider-settings.js";

const identity = "You are an AI agent powered by DeepSeek Harness.";
const profileText = "PROFILE_CONFIG_SENTINEL: preserve literal {{model}}.";
const render = (messages: ModelMessage[]) => messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");

async function fixture() {
  const taskRoot = await mkdtemp(join(tmpdir(), "harness-prompt-backend-"));
  const workspace = join(taskRoot, "workspace");
  await mkdir(workspace);
  const vault = await VaultCrypto.open(join(taskRoot, "key.json"), "prompt-backend-test-password");
  const database = await HarnessDatabase.open(join(taskRoot, "db.sqlite"), vault);
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const engines: HarnessEngine[] = [];
  const settingsPath = join(taskRoot, "provider-settings.json");
  const sessionId = newId("session");
  database.createSession({ id: sessionId, profileId: DEFAULT_PROFILE.id, workspacePath: workspace, title: "新会话", createdAt: nowIso(), updatedAt: nowIso() });

  function configured(env: NodeJS.ProcessEnv) {
    const providers = createConfiguredProviders({ env, attachmentResolver: async () => { throw new Error("No fixture attachments"); },
      fetchImpl: async () => { throw new Error("Network calls are forbidden in this fixture"); } });
    for (const provider of providers) {
      provider.stream = async function* (request): AsyncIterable<ProviderStreamEvent> {
        requests.push(structuredClone(request));
        yield { type: "text_delta", delta: "The model configuration was applied." };
      };
    }
    return providers;
  }

  async function saveModel(baseUrl: string, promptBackend: PromptBackendSelection = "auto") {
    await saveProviderSettings(settingsPath, { openaiCompatibleBaseUrl: baseUrl, openaiCompatibleModel: "configured-model", promptBackend });
    const saved = await loadProviderSettings(settingsPath);
    return { saved, providers: configured(providerSettingsEnvironment(saved)) };
  }

  function engineFor(providers: ModelProvider[]) {
    const engine = new HarnessEngine({ database, providers, tools: new ToolRegistry(), memory: new MemoryService(database),
      skills: new SkillService(join(taskRoot, "skills")), projectTrust: new ProjectTrustService(database) });
    engine.on("event", (event: AgentEvent) => { events.push(event); });
    engines.push(engine);
    return engine;
  }

  async function run(engine: HarnessEngine, providerId = "openai-compatible", request = "Explain the model configuration; do not modify any files.") {
    const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [providerId], systemPrompt: profileText, toolNames: [], memoryScopes: [] };
    const spec: RunSpec = { id: newId("run"), sessionId, request, taskMode: "auto", profileId: profile.id, workspacePath: workspace,
      attachments: [], grants: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 4, maxToolCalls: 8 } };
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); engine.off("event", onResult); reject(new Error("Prompt backend run timed out")); }, 20_000);
      const onResult = (event: AgentEvent) => {
        if (event.type === "result" && event.runId === spec.id) { clearTimeout(timer); engine.off("event", onResult); resolve(event); }
      };
      engine.on("event", onResult);
      try { engine.start(spec, profile); }
      catch (error) { clearTimeout(timer); engine.off("event", onResult); reject(error); }
    });
    await engine.waitForSettlement(spec.id);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const mainRequests = requests.filter(item => item.runId === spec.id && item.purpose === "main");
    expect(mainRequests).toHaveLength(1);
    return { spec, request: mainRequests[0]!, result };
  }

  return { requests, events, configured, saveModel, engineFor, run, database, sessionId,
    async close() {
      for (const engine of engines) await engine.close();
      database.close(); vault.dispose();
      const child = relative(tmpdir(), taskRoot);
      if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe fixture cleanup");
      await rm(taskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

describe("configuration-bound prompt backend through HarnessEngine", { timeout: 30_000 }, () => {
  it.each([
    { baseUrl: "https://api.deepseek.com/v1", selection: "auto", expected: "dsh" },
    { baseUrl: "https://api.deepseek.com/v1", selection: "harness", expected: "harness" },
    { baseUrl: "https://proxy.example/v1", selection: "dsh", expected: "dsh" },
  ] as const)("sends $expected policy for saved $selection on $baseUrl", async ({ baseUrl, selection, expected }) => {
    const f = await fixture();
    try {
      const loaded = await f.saveModel(baseUrl, selection);
      expect(loaded.saved.resolvedPromptBackend).toBe(expected);
      const { request, spec } = await f.run(f.engineFor(loaded.providers));
      const systems = request.messages.filter(message => message.role === "system");
      expect(render(systems).includes(identity)).toBe(expected === "dsh");
      expect(request.messages.find(message => message.role === "developer")?.content[0]).toMatchObject({ type: "text", text: profileText, trust: "user_profile" });
      expect(render(systems)).not.toContain(profileText);
      expect(render(request.messages)).toContain(spec.request);
      expect(f.events.find(event => event.type === "route" && event.runId === spec.id)).toMatchObject({ reason: expect.stringContaining(`prompt=${expected}@`) });
    } finally { await f.close(); }
  });

  it("isolates simultaneous providers and routes with the selected provider's backend", async () => {
    const f = await fixture();
    try {
      const providers = f.configured({ OPENAI_API_KEY: "fixture", OPENAI_COMPATIBLE_BASE_URL: "https://api.deepseek.com/v1", OPENAI_COMPATIBLE_MODEL: "configured-model" });
      const engine = f.engineFor(providers);
      const [deepseek, ordinary] = await Promise.all([f.run(engine), f.run(engine, "openai")]);
      expect(render(deepseek.request.messages.filter(message => message.role === "system"))).toContain(identity);
      expect(render(ordinary.request.messages.filter(message => message.role === "system"))).not.toContain(identity);
      expect(deepseek.request.model.providerId).toBe("openai-compatible");
      expect(ordinary.request.model.providerId).toBe("openai");
      expect(providers.map(provider => provider.promptBackend)).toEqual(["harness", "dsh"]);
    } finally { await f.close(); }
  });

  it("rebuilds the next run from newly saved settings without retaining prior system policy", async () => {
    const f = await fixture();
    try {
      const before = await f.saveModel("https://api.deepseek.com/v1");
      const firstEngine = f.engineFor(before.providers);
      const first = await f.run(firstEngine, "openai-compatible", "First configuration question.");
      await firstEngine.close();

      const after = await f.saveModel("https://proxy.example/v1");
      const second = await f.run(f.engineFor(after.providers), "openai-compatible", "Continue our configuration discussion.");
      expect(before.saved.resolvedPromptBackend).toBe("dsh");
      expect(after.saved.resolvedPromptBackend).toBe("harness");
      expect(first.request.model.modelId).toBe(second.request.model.modelId);
      expect(render(first.request.messages)).toContain(identity);
      expect(render(second.request.messages)).not.toContain(identity);
      expect(render(second.request.messages)).toContain("First configuration question.");
      expect(first.request.promptCacheKey).not.toBe(second.request.promptCacheKey);
      expect(f.database.getSessionDetail(f.sessionId)?.runs).toHaveLength(2);
    } finally { await f.close(); }
  });
});
