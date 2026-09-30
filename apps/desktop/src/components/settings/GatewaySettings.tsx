import React from "react";
import { SettingsRow, SettingsSection } from "./SettingsSection.js";

export function GatewaySettings() {
  return (
    <SettingsSection title="团队模型网关">
      <SettingsRow
        title="网关连接"
        description="在 Profile 中配置 Gateway URL 与设备令牌。网关默认只保存用量审计。"
      >
        <span className="settings-hint">在 Profile 中管理</span>
      </SettingsRow>
      <SettingsRow
        title="启动自托管网关"
        description="在网关项目目录中运行以下命令。"
      >
        <code>docker compose up --build</code>
      </SettingsRow>
    </SettingsSection>
  );
}
