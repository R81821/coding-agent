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
