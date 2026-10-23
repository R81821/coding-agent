import { expect, it } from "vitest";
import { createConfiguredProviders } from "@harness/providers";
it("routes with an explicitly configured capacity and retains default when absent", async () => {
  const env = { OPENAI_COMPATIBLE_BASE_URL: "https://fixture.test/v1", OPENAI_COMPATIBLE_MODEL: "fixture", OPENAI_COMPATIBLE_API_PROTOCOL: "auto" };
  const options = { attachmentResolver: async () => { throw Error("unused"); } };
  const configured = createConfiguredProviders({ ...options, env: { ...env, OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "65536" } });
  expect((await configured[0]!.listModels())[0]!.capabilities.maxContextTokens).toBe(65536);
  expect((await createConfiguredProviders({ ...options, env })[0]!.listModels())[0]!.capabilities.maxContextTokens).toBe(128000);
  expect(() => createConfiguredProviders({ ...options, env: { ...env, OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "invalid" } })).toThrow(/context/i);
});

it.each([
  { id: "openai", prefix: "OPENAI", env: { OPENAI_API_KEY: "fixture" } },
  { id: "anthropic", prefix: "ANTHROPIC", env: { ANTHROPIC_API_KEY: "fixture" } },
  { id: "gemini", prefix: "GEMINI", env: { GEMINI_API_KEY: "fixture" } },
  { id: "openai-compatible", prefix: "OPENAI_COMPATIBLE", env: { OPENAI_COMPATIBLE_BASE_URL: "https://fixture.test/v1", OPENAI_COMPATIBLE_MODEL: "fixture" } },
  { id: "gateway", prefix: "HARNESS_GATEWAY", env: { HARNESS_GATEWAY_URL: "https://fixture.test", HARNESS_GATEWAY_TOKEN: "fixture", HARNESS_GATEWAY_MODEL: "fixture" } },
])("keeps $id context and output capacities independent", async ({ id, prefix, env }) => {
  const options = { attachmentResolver: async () => { throw Error("unused"); } };
  const providers = createConfiguredProviders({ ...options, env: { ...env, [`${prefix}_MAX_CONTEXT_TOKENS`]: "1000000", [`${prefix}_MAX_OUTPUT_TOKENS`]: "393216" } });
  expect((await providers.find(provider => provider.id === id)!.listModels())[0]!.capabilities).toMatchObject({ maxContextTokens: 1_000_000, maxOutputTokens: 393_216 });
  for (const invalid of ["invalid", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
    expect(() => createConfiguredProviders({ ...options, env: { ...env, [`${prefix}_MAX_OUTPUT_TOKENS`]: invalid } })).toThrow(/output/i);
  }
});
