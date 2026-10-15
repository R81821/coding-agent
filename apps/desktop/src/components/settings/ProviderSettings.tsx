import React, { useEffect, useState } from "react";
import type { ProviderSettings as ProviderConfig } from "../../provider-settings.js";
import { BuiButton } from "../../ui/button.js";
import {
  SettingsMessage,
  SettingsRow,
  SettingsSection,
  useSettingsAction,
} from "./SettingsSection.js";

export function ProviderSettings({ refresh }: { refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<ProviderConfig>({
    openaiCompatibleBaseUrl: "",
    openaiCompatibleModel: "",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const action = useSettingsAction();
  useEffect(() => {
    let cancelled = false;
    void window.harness
      .providerSettings()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <>
      <SettingsSection title="OpenAI-compatible">
        <fieldset
          className="settings-fields"
          disabled={loading || action.busy || Boolean(loadError)}
        >
          <legend className="sr-only">兼容 API 配置</legend>
          <SettingsRow
            title="API 根地址"
            description="通常以 /v1 结尾。地址与模型 ID 同时留空可禁用此服务。"
          >
            <input
              aria-label="API 根地址"
              type="url"
              value={config.openaiCompatibleBaseUrl}
              placeholder="http://127.0.0.1:11434/v1"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  openaiCompatibleBaseUrl: event.target.value,
                }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title="模型 ID"
            description="填写服务提供的实际模型名称。"
          >
            <input
              aria-label="模型 ID"
              value={config.openaiCompatibleModel}
              placeholder="例如 qwen3-coder"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  openaiCompatibleModel: event.target.value,
                }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title="API 协议"
            description="选择服务所支持的请求协议。"
          >
            <select
              aria-label="API 协议"
              value={config.apiProtocol ?? "auto"}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  apiProtocol: event.target.value as
                    "auto" | "responses" | "chat_completions",
                }))
              }
            >
              <option value="auto">自动选择</option>
              <option value="responses">Responses</option>
              <option value="chat_completions">Chat Completions</option>
            </select>
          </SettingsRow>
          <SettingsRow
            title="模型上下文容量"
            description="单位为 tokens。留空沿用默认 128000，请以服务商公布的模型规格为准。"
          >
            <input
              aria-label="模型上下文容量"
              type="number"
              min={1}
              step={1}
              value={config.maxContextTokens ?? ""}
              placeholder="128000"
              onChange={(event) =>
                setConfig((current) => {
                  const { maxContextTokens: _previous, ...rest } = current;
                  return event.target.value === ""
                    ? rest
                    : { ...rest, maxContextTokens: Number(event.target.value) };
                })
              }
            />
          </SettingsRow>
          <div className="settings-actions">
            <BuiButton
              variant="primary"
              onClick={() =>
                void action.run(async () => {
                  const saved =
                    await window.harness.setProviderSettings(config);
                  setConfig(saved);
                  await refresh();
                  return saved.openaiCompatibleBaseUrl
                    ? "已保存并重新加载运行时"
                    : "OpenAI-compatible 已禁用";
                })
              }
            >
              {action.busy ? "保存中…" : "保存并重载"}
            </BuiButton>
          </div>
        </fieldset>
      </SettingsSection>
      {loading && <p role="status">正在读取配置…</p>}
      <SettingsMessage message={loadError} error />
      <SettingsMessage {...action} />
    </>
  );
}
