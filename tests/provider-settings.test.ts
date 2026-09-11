import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  loadProviderSettings,
  normalizeProviderSettings,
  providerSettingsEnvironment,
  saveProviderSettings,
} from "../apps/desktop/src/provider-settings.js";

describe("desktop provider settings", () => {
  it("normalizes an OpenAI-compatible endpoint and maps it to daemon env", () => {
    const settings = normalizeProviderSettings({
      openaiCompatibleBaseUrl: " http://127.0.0.1:11434/v1/ ",
      openaiCompatibleModel: " qwen3-coder ",
    });
    expect(settings).toEqual({
      openaiCompatibleBaseUrl: "http://127.0.0.1:11434/v1",
      openaiCompatibleModel: "qwen3-coder",
    });
    expect(providerSettingsEnvironment(settings)).toEqual({
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
      OPENAI_COMPATIBLE_MODEL: "qwen3-coder",
    });
  });

  it("requires URL and model together and rejects embedded credentials", () => {
    expect(() =>
      normalizeProviderSettings({
        openaiCompatibleBaseUrl: "https://example.test/v1",
        openaiCompatibleModel: "",
      }),
    ).toThrow(/同时填写/);
    expect(() =>
      normalizeProviderSettings({
        openaiCompatibleBaseUrl: "https://user:pass@example.test/v1",
        openaiCompatibleModel: "model",
      }),
    ).toThrow(/用户名或密码/);
  });

  it("persists updates repeatedly and can be disabled", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "harness-provider-settings-"),
    );
    const path = join(directory, "provider-settings.json");
    try {
      await saveProviderSettings(path, {
        openaiCompatibleBaseUrl: "http://localhost:11434/v1",
        openaiCompatibleModel: "model-a",
      });
      await saveProviderSettings(path, {
        openaiCompatibleBaseUrl: "http://localhost:1234/v1",
        openaiCompatibleModel: "model-b",
      });
      expect(await loadProviderSettings(path)).toEqual({
        openaiCompatibleBaseUrl: "http://localhost:1234/v1",
        openaiCompatibleModel: "model-b",
      });
      await saveProviderSettings(path, {
        openaiCompatibleBaseUrl: "",
        openaiCompatibleModel: "",
      });
      expect(await loadProviderSettings(path)).toEqual({
        openaiCompatibleBaseUrl: "",
        openaiCompatibleModel: "",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("validates and persists explicit protocol and context capacity", async () => {
  const settings = normalizeProviderSettings({ openaiCompatibleBaseUrl: "https://fixture.test/v1", openaiCompatibleModel: "fixture", apiProtocol: "responses", maxContextTokens: 65536 });
  expect(settings).toMatchObject({ apiProtocol: "responses", maxContextTokens: 65536 });
  expect(providerSettingsEnvironment(settings)).toMatchObject({ OPENAI_COMPATIBLE_API_PROTOCOL: "responses", OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "65536" });
  for (const invalid of [0, -1, 1.5, "NaN", "128k"]) expect(() => normalizeProviderSettings({ ...settings, maxContextTokens: invalid })).toThrow(/上下文/);
  expect(() => normalizeProviderSettings({ ...settings, apiProtocol: "invalid" })).toThrow(/协议/);
});
