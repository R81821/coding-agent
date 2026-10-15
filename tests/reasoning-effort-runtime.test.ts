import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRuntime } from "@harness/core";
import { DEFAULT_PROFILE, nowIso, type RunSpec } from "@harness/protocol";

describe("session reasoning RPC runtime", { timeout: 20000 }, () => {
  it("previews the settings-derived model and persists only effort with the current Profile", async () => {
    const path = await mkdtemp(join(tmpdir(), "model-choice-runtime-"));
    const runtime = await createRuntime({ appDataPath: path, passphrase: "runtime-model-choice-password", env: {
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_COMPATIBLE_MODEL: "gpt-5.4", OPENAI_COMPATIBLE_API_PROTOCOL: "chat_completions",
    } });
    try {
      const at = nowIso();
      const disabledProfile = { ...DEFAULT_PROFILE, id: "disabled", allowedProviders: [] };
      runtime.profiles.set(disabledProfile.id, disabledProfile);
      runtime.database.createSession({ id: "session", workspacePath: path, profileId: disabledProfile.id, title: "Choose model", createdAt: at, updatedAt: at });
      const preview = await runtime.currentModel(DEFAULT_PROFILE.id);
      expect(preview.model).toMatchObject({ providerId: "openai-compatible", modelId: "gpt-5.4" });
      expect(preview.error).toBeUndefined();
      expect(await runtime.currentModel(disabledProfile.id)).toMatchObject({ model: null, error: expect.stringContaining("未授权") });
      await expect(runtime.setSessionReasoning("session", "high")).rejects.toThrow("未授权");
      const saved = await runtime.setSessionReasoning("session", "high", DEFAULT_PROFILE.id);
      expect(saved).toMatchObject({ profileId: DEFAULT_PROFILE.id, reasoningEffort: "high" });
      expect(saved).not.toHaveProperty("modelSelection");
      expect(runtime.database.getSessionView("session")?.session).toMatchObject({ profileId: DEFAULT_PROFILE.id, reasoningEffort: "high" });
      await expect(runtime.setSessionReasoning("session", "max")).rejects.toThrow("不支持推理等级");
      expect(runtime.database.getSessionDetail("session")?.session.reasoningEffort).toBe("high");
      expect((await runtime.currentModel(DEFAULT_PROFILE.id)).model?.modelId).toBe("gpt-5.4");
      expect((await runtime.setSessionReasoning("session", null)).reasoningEffort).toBeNull();
      expect(runtime.database.listSessions().items[0]?.reasoningEffort).toBeNull();
      expect(await runtime.currentModel("unknown")).toMatchObject({ model: null, error: expect.stringContaining("Unknown profile") });
      // The same attachment requirement applies to preview and effort validation.
      preview.model!.capabilities.vision = false;
      expect(await runtime.currentModel(DEFAULT_PROFILE.id, true)).toMatchObject({ model: null, error: expect.stringContaining("图片输入") });
      await expect(runtime.setSessionReasoning("session", "high", DEFAULT_PROFILE.id, true)).rejects.toThrow("图片输入");
    } finally { await runtime.close(); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("rejects changes for paused/running and deleted sessions", async () => {
    const path = await mkdtemp(join(tmpdir(), "model-choice-guard-"));
    const runtime = await createRuntime({ appDataPath: path, passphrase: "runtime-model-choice-password", env: {} });
    try {
      const at = nowIso();
      runtime.database.createSession({ id: "session", workspacePath: path, profileId: DEFAULT_PROFILE.id, title: "Busy", createdAt: at, updatedAt: at });
      const spec: RunSpec = { id: "paused", sessionId: "session", workspacePath: path, profileId: DEFAULT_PROFILE.id, request: "Analyze", createdAt: at, budget: DEFAULT_PROFILE.budget, attachments: [], grants: [] };
      runtime.database.saveRun(spec, "paused");
      await expect(runtime.setSessionReasoning("session", null)).rejects.toThrow("当前任务结束");
      runtime.database.updateRunStatus(spec.id, "running");
      await expect(runtime.setSessionReasoning("session", null)).rejects.toThrow("当前任务结束");
      runtime.database.updateRunStatus(spec.id, "completed");
      expect((await runtime.setSessionReasoning("session", null)).reasoningEffort).toBeNull();
      runtime.database.deleteSession("session");
      await expect(runtime.setSessionReasoning("session", null)).rejects.toThrow("会话不存在");
    } finally { await runtime.close(); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
