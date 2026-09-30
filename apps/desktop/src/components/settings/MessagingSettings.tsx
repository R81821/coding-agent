import React from "react";
import { BuiButton } from "../../ui/button.js";
import {
  SettingsMessage,
  SettingsRow,
  SettingsSection,
  useSettingsAction,
} from "./SettingsSection.js";

export function MessagingSettings() {
  const action = useSettingsAction();
  const pair = (connector: "telegram" | "feishu") =>
    action.run(async () => {
      const result = await window.harness.request<{ code: string }>({
        method: "connectors.pairing",
        params: { connector },
      });
      return `${connector === "telegram" ? "Telegram" : "飞书"} 配对码：${result.code}`;
    });
  return (
    <>
      <SettingsSection title="消息渠道">
        <SettingsRow
          title="Telegram"
          description="配对后可以创建任务、查看状态和处理审批。"
        >
          <BuiButton
            variant="secondary"
            disabled={action.busy}
            onClick={() => void pair("telegram")}
          >
            Telegram 配对码
          </BuiButton>
        </SettingsRow>
        <SettingsRow title="飞书" description="通过飞书连接本地工作台。">
          <BuiButton
            variant="secondary"
            disabled={action.busy}
            onClick={() => void pair("feishu")}
          >
            飞书配对码
          </BuiButton>
        </SettingsRow>
      </SettingsSection>
      <SettingsMessage {...action} />
    </>
  );
}
