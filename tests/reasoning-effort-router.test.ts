import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, DaemonRequestSchema, ReasoningEffortSchema, type ModelDescriptor, type ModelRequest } from "@harness/protocol";
import { descriptor, ModelRouter, type ModelProvider } from "@harness/providers";

function fixtureProvider(id: string, overrides: Partial<ModelDescriptor> = {}): ModelProvider {
  const model = descriptor({ providerId: id, modelId: "configured-model", displayName: id, qualityScore: 0.8,
    capabilities: { vision: true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local", reasoningEfforts: ["low", "medium", "high", "max"] }, ...overrides });
  return { id, listModels: vi.fn(async () => [model]), health: async () => true, estimateCost: () => 0,
    async *stream(_request: ModelRequest) { yield { type: "text_delta", delta: "ok" }; } };
}
const requirements = { needsVision: false, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 100, estimatedOutputTokens: 1000 };

describe("reasoning strength independent of model routing", () => {
  it.each(["low", "medium", "high", "max"] as const)("keeps the settings-derived model for %s strength", async reasoningEffort => {
    const lower = fixtureProvider("lower", { qualityScore: 0.1 }), better = fixtureProvider("better", { qualityScore: 1 });
    const profile = { ...DEFAULT_PROFILE, allowedProviders: [lower.id, better.id] }, router = new ModelRouter([lower, better]);
    const normal = await router.route(profile, requirements), withEffort = await router.route(profile, { ...requirements, reasoningEffort });
    expect(withEffort.provider).toBe(normal.provider);
    expect(withEffort.model.modelId).toBe(normal.model.modelId);
    expect(withEffort.provider).toBe(better);
    expect(lower.listModels).toHaveBeenCalled();
  });

  it("rejects unsupported effort after selecting the usual winner instead of switching to a supporting model", async () => {
    const lower = fixtureProvider("supporting", { qualityScore: 0.1 }), better = fixtureProvider("configured", { qualityScore: 1 });
    (await better.listModels())[0]!.capabilities.reasoningEfforts = ["low"];
    const router = new ModelRouter([lower, better]), profile = { ...DEFAULT_PROFILE, allowedProviders: [lower.id, better.id] };
    expect((await router.route(profile, requirements)).provider).toBe(better);
    await expect(router.route(profile, { ...requirements, reasoningEffort: "high" })).rejects.toThrow("当前配置模型 configured/configured-model 不支持推理等级");
    expect((await router.route(profile, { ...requirements, reasoningEffort: null })).provider).toBe(better);
  });

  it.each(["unhealthy", "context", "vision", "tools", "budget", "lookup"] as const)("preserves ordinary %s routing gates", async issue => {
    const first = fixtureProvider("first", { qualityScore: 1 }), second = fixtureProvider("second", { qualityScore: .1 });
    const model = (await first.listModels())[0]!;
    let input = requirements;
    if (issue === "unhealthy") model.healthy = false;
    if (issue === "context") model.capabilities.maxContextTokens = 1000;
    if (issue === "vision") { model.capabilities.vision = false; input = { ...input, needsVision: true }; }
    if (issue === "tools") model.capabilities.tools = false;
    if (issue === "budget") first.estimateCost = () => 10;
    if (issue === "lookup") first.listModels = async () => { throw new Error("lookup failed"); };
    const router = new ModelRouter([first, second]), profile = { ...DEFAULT_PROFILE, allowedProviders: [first.id, second.id] };
    expect((await router.route(profile, input)).provider).toBe(second);
    expect((await router.route(profile, { ...input, reasoningEffort: "high" })).provider).toBe(second);
  });

  it("does not query providers outside the Profile allow-list", async () => {
    const allowed = fixtureProvider("allowed"), blocked = fixtureProvider("blocked", { qualityScore: 1 });
    const route = await new ModelRouter([allowed, blocked]).route({ ...DEFAULT_PROFILE, allowedProviders: [allowed.id] }, { ...requirements, reasoningEffort: "high" });
    expect(route.provider).toBe(allowed);
    expect(blocked.listModels).not.toHaveBeenCalled();
  });
});

describe("independent reasoning RPC contract", () => {
  it("accepts settings-derived model preview and scalar strength while rejecting model-picker RPCs", () => {
    expect(DaemonRequestSchema.parse({ id: "preview", method: "model.current", params: { profileId: "default", needsVision: true } })).toMatchObject({ method: "model.current" });
    expect(DaemonRequestSchema.parse({ id: "effort", method: "session.reasoning", params: { sessionId: "session", reasoningEffort: null, needsVision: true } })).toMatchObject({ params: { reasoningEffort: null } });
    expect(ReasoningEffortSchema.parse("max")).toBe("max");
    expect(ReasoningEffortSchema.safeParse("unknown").success).toBe(false);
    expect(DaemonRequestSchema.safeParse({ id: "old", method: "session.model", params: { sessionId: "session", modelSelection: null } }).success).toBe(false);
    expect(DaemonRequestSchema.safeParse({ id: "old", method: "models.list", params: { profileId: "default" } }).success).toBe(false);
  });
});
