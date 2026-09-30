import React, { useCallback, useEffect, useRef, useState } from "react";
import { BuiButton } from "../../ui/button.js";
import {
  SettingsMessage,
  SettingsRow,
  SettingsSection,
  useSettingsAction,
} from "./SettingsSection.js";

export function SearchSettings({ active }: { active: boolean }) {
  const [credentials, setCredentials] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<{ healthy: boolean; detail?: string }>();
  const [searchKey, setSearchKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [loadError, setLoadError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const action = useSettingsAction();
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      window.harness.request<{ healthy: boolean; detail?: string }>({
        method: "search.status",
      }),
      window.harness.credentialStatus(),
    ]);
    const [health, keys] = results;
    setStatus(
      health.status === "fulfilled"
        ? health.value
        : { healthy: false, detail: "暂时无法连接运行时" },
    );
    if (keys.status === "fulfilled") {
      setCredentials(keys.value);
      setLoadError("");
    } else setLoadError("无法读取已保存的凭据状态，请稍后重试。");
  }, []);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function reloadStatus() {
    setStatus({ healthy: false, detail: "运行时正在重新加载…" });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 3000);
  }
  function save(name: "PARALLEL_API_KEY" | "GITHUB_TOKEN", value: string) {
    if (!value.trim() || action.busy) return;
    void action.run(async () => {
      setCredentials(await window.harness.setCredential(name, value));
      if (name === "PARALLEL_API_KEY") setSearchKey("");
      else setGithubToken("");
      reloadStatus();
      return "已保存，运行时正在重新加载";
    });
  }
  return (
    <>
      <SettingsSection title="Parallel Search">
        <SettingsRow
          title="搜索状态"
          description={
            status?.healthy
              ? "Parallel Search 已就绪"
              : (status?.detail ?? "正在检查…")
          }
        >
          <BuiButton
            variant="ghost"
            disabled={action.busy}
            onClick={() => void refresh()}
          >
            重新检查
          </BuiButton>
        </SettingsRow>
        <SettingsRow
          title="Parallel API Key"
          description="配置网页检索服务。含仓库内容的查询仍会触发数据外发审批。"
        >
          <input
            aria-label="Parallel API Key"
            type="password"
            autoComplete="off"
            disabled={action.busy}
            value={searchKey}
            onChange={(event) => setSearchKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save("PARALLEL_API_KEY", searchKey);
              }
            }}
            placeholder={
              credentials.PARALLEL_API_KEY
                ? "已保存 · 粘贴以替换"
                : "粘贴 Parallel API Key"
            }
          />
        </SettingsRow>
        <div className="settings-actions">
          <BuiButton
            variant="primary"
            disabled={action.busy || !searchKey.trim()}
            onClick={() => save("PARALLEL_API_KEY", searchKey)}
          >
            保存搜索密钥
          </BuiButton>
          {credentials.PARALLEL_API_KEY && (
            <BuiButton
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setCredentials(
                    await window.harness.deleteCredential("PARALLEL_API_KEY"),
                  );
                  reloadStatus();
                  return "搜索密钥已删除";
                })
              }
            >
              删除密钥
            </BuiButton>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title="GitHub">
        <SettingsRow
          title="GitHub Token"
          description="可选，用于认证 GitHub 请求。搜索密钥与此令牌分别保存。"
        >
          <input
            aria-label="GitHub Token"
            type="password"
            autoComplete="off"
            disabled={action.busy}
            value={githubToken}
            onChange={(event) => setGithubToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save("GITHUB_TOKEN", githubToken);
              }
            }}
            placeholder={
              credentials.GITHUB_TOKEN
                ? "已保存 · 粘贴以替换"
                : "粘贴 GitHub Token（可选）"
            }
          />
        </SettingsRow>
        <div className="settings-actions">
          <BuiButton
            variant="secondary"
            disabled={action.busy || !githubToken.trim()}
            onClick={() => save("GITHUB_TOKEN", githubToken)}
          >
            保存 GitHub Token
          </BuiButton>
        </div>
      </SettingsSection>
      <SettingsMessage message={loadError} error />
      <SettingsMessage {...action} />
    </>
  );
}
