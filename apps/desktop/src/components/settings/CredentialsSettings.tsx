import React, { useEffect, useState } from "react";
import { BuiButton } from "../../ui/button.js";
import {
  SettingsMessage,
  SettingsRow,
  SettingsSection,
  useSettingsAction,
} from "./SettingsSection.js";

const CREDENTIAL_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "PARALLEL_API_KEY",
  "HARNESS_GATEWAY_TOKEN",
];

export function CredentialsSettings({ active }: { active: boolean }) {
  const [credentials, setCredentials] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("OPENAI_API_KEY");
  const [value, setValue] = useState("");
  const [loadError, setLoadError] = useState("");
  const action = useSettingsAction();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.harness
      .credentialStatus()
      .then((next) => {
        if (!cancelled) {
          setCredentials(next);
          setLoadError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return (
    <>
      <SettingsSection title="Windows 凭据">
        <SettingsRow
          title="凭据类型"
          description="密钥仅保存在当前 Windows 用户的 Credential Locker 中。"
        >
          <select
            aria-label="凭据类型"
            value={name}
            disabled={action.busy}
            onChange={(event) => {
              setName(event.target.value);
              setValue("");
            }}
          >
            {CREDENTIAL_NAMES.map((key) => (
              <option key={key} value={key}>
                {key}
                {credentials[key] ? " · 已保存" : ""}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          title="API 密钥"
          description={
            credentials[name]
              ? "已有密钥。填写新值可替换，不会回显已保存的内容。"
              : "填写此服务的 API 密钥。"
          }
        >
          <input
            aria-label="API 密钥"
            type="password"
            autoComplete="off"
            value={value}
            disabled={action.busy}
            onChange={(event) => setValue(event.target.value)}
            placeholder="粘贴密钥"
          />
        </SettingsRow>
        <div className="settings-actions">
          <BuiButton
            variant="primary"
            disabled={action.busy || !value.trim()}
            onClick={() =>
              void action.run(async () => {
                setCredentials(await window.harness.setCredential(name, value));
                setValue("");
                return "密钥已安全保存，运行时已重新加载";
              })
            }
          >
            安全保存
          </BuiButton>
          <BuiButton
            variant="danger"
            disabled={action.busy || !credentials[name]}
            onClick={() =>
              void action.run(async () => {
                setCredentials(await window.harness.deleteCredential(name));
                return "凭据已删除";
              })
            }
          >
            删除密钥
          </BuiButton>
        </div>
      </SettingsSection>
      <SettingsMessage message={loadError} error />
      <SettingsMessage {...action} />
    </>
  );
}
