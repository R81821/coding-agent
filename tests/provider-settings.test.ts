import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  loadProviderSettings,
  normalizeProviderSettings,
  providerSettingsEnvironment,
  resolveProviderPromptBackend,
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
      promptBackend: "auto",
      resolvedPromptBackend: "harness",
    });
    expect(providerSettingsEnvironment(settings)).toEqual({
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
      OPENAI_COMPATIBLE_MODEL: "qwen3-coder",
      OPENAI_COMPATIBLE_PROMPT_BACKEND: "harness",
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
        promptBackend: "auto",
        resolvedPromptBackend: "harness",
      });
      expect(await loadProviderSettings(path)).toEqual({
        openaiCompatibleBaseUrl: "http://localhost:1234/v1",
        openaiCompatibleModel: "model-b",
        promptBackend: "auto",
        resolvedPromptBackend: "harness",
      });
      await saveProviderSettings(path, {
        openaiCompatibleBaseUrl: "",
        openaiCompatibleModel: "",
        promptBackend: "auto",
        resolvedPromptBackend: "harness",
      });
      expect(await loadProviderSettings(path)).toEqual({
        openaiCompatibleBaseUrl: "",
        openaiCompatibleModel: "",
        promptBackend: "auto",
        resolvedPromptBackend: "harness",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("model-bound prompt backend settings", () => {
  const model = { openaiCompatibleBaseUrl: "https://api.deepseek.com/v1", openaiCompatibleModel: "deepseek-flash" };

  it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"])("binds the official endpoint %s to dsh when saved", baseUrl => {
    const settings = normalizeProviderSettings({ ...model, openaiCompatibleBaseUrl: baseUrl });
    expect(settings).toMatchObject({ promptBackend: "auto", resolvedPromptBackend: "dsh" });
    expect(providerSettingsEnvironment(settings)).toMatchObject({ OPENAI_COMPATIBLE_PROMPT_BACKEND: "dsh" });
  });

  it.each([
    "https://api.deepseek.com.evil.test/v1",
    "https://deepseek-proxy.test/v1",
    "http://api.deepseek.com/v1",
    "https://api.deepseek.com:8443/v1",
    "https://api.deepseek.com/proxy/v1",
  ])("keeps the original system for an unverified endpoint %s", baseUrl => {
    const settings = normalizeProviderSettings({ ...model, openaiCompatibleBaseUrl: baseUrl });
    expect(settings.resolvedPromptBackend).toBe("harness");
    expect(providerSettingsEnvironment(settings).OPENAI_COMPATIBLE_PROMPT_BACKEND).toBe("harness");
  });

  it("supports explicit overrides for both official endpoints and proxies", () => {
    const original = normalizeProviderSettings({ ...model, promptBackend: "harness" });
    const proxy = normalizeProviderSettings({ ...model, openaiCompatibleBaseUrl: "https://proxy.test/v1", promptBackend: "dsh" });
    expect(original.resolvedPromptBackend).toBe("harness");
    expect(proxy.resolvedPromptBackend).toBe("dsh");
    expect(providerSettingsEnvironment(proxy).OPENAI_COMPATIBLE_PROMPT_BACKEND).toBe("dsh");
    for (const invalid of [null, "other", true, ["dsh"], { backend: "dsh" }]) {
      expect(() => normalizeProviderSettings({ ...model, promptBackend: invalid })).toThrow(/提示词系统/);
    }
  });

  it("rebinds after endpoint edits and ignores an obsolete cached backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-provider-prompt-settings-"));
    const path = join(directory, "provider-settings.json");
    try {
      const deepseek = await saveProviderSettings(path, model);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ resolvedPromptBackend: "dsh" });
      const other = await saveProviderSettings(path, { ...deepseek, openaiCompatibleBaseUrl: "https://other.test/v1" });
      expect(other.resolvedPromptBackend).toBe("harness");
      expect((await loadProviderSettings(path)).resolvedPromptBackend).toBe("harness");
      expect(providerSettingsEnvironment(other).OPENAI_COMPATIBLE_PROMPT_BACKEND).toBe("harness");
      const back = await saveProviderSettings(path, { ...other, ...model });
      expect(back.resolvedPromptBackend).toBe("dsh");
      const disabled = await saveProviderSettings(path, { ...back, promptBackend: "dsh", openaiCompatibleBaseUrl: "", openaiCompatibleModel: "" });
      expect(disabled).toMatchObject({ promptBackend: "auto", resolvedPromptBackend: "harness" });
      expect(providerSettingsEnvironment(disabled)).toEqual({ OPENAI_COMPATIBLE_PROMPT_BACKEND: "harness" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates old settings and recomputes forged or stale persisted resolutions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-provider-prompt-legacy-"));
    const path = join(directory, "provider-settings.json");
    try {
      await writeFile(path, JSON.stringify(model));
      expect(await loadProviderSettings(path)).toMatchObject({ promptBackend: "auto", resolvedPromptBackend: "dsh" });
      await writeFile(path, JSON.stringify({ ...model, resolvedPromptBackend: "harness" }));
      expect((await loadProviderSettings(path)).resolvedPromptBackend).toBe("dsh");
      const forged = { ...model, openaiCompatibleBaseUrl: "https://other.test/v1", resolvedPromptBackend: "dsh" as const };
      expect(providerSettingsEnvironment(forged).OPENAI_COMPATIBLE_PROMPT_BACKEND).toBe("harness");
      expect(resolveProviderPromptBackend({ ...model, openaiCompatibleModel: "" })).toBe("harness");
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

it("preserves a separate output capacity through desktop persistence and daemon environment", async () => {
  const settings = normalizeProviderSettings({ openaiCompatibleBaseUrl: "https://fixture.test/v1", openaiCompatibleModel: "fixture", maxContextTokens: 1_000_000, maxOutputTokens: 393_216 });
  expect(providerSettingsEnvironment(settings)).toMatchObject({ OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "1000000", OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS: "393216" });
  for (const invalid of [0, -1, 1.5, "32768", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => normalizeProviderSettings({ ...settings, maxOutputTokens: invalid })).toThrow(/输出/);
  const directory = await mkdtemp(join(tmpdir(), "harness-provider-output-settings-"));
  try {
    const path = join(directory, "provider-settings.json");
    await saveProviderSettings(path, settings);
    expect(await loadProviderSettings(path)).toEqual(settings);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
