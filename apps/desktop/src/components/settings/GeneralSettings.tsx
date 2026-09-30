import React from "react";
import { BuiButton } from "../../ui/button.js";
import {
  SettingsMessage,
  SettingsRow,
  SettingsSection,
  useSettingsAction,
} from "./SettingsSection.js";

export function GeneralSettings({ refresh }: { refresh: () => Promise<void> }) {
  const action = useSettingsAction();
  return (
    <>
      <SettingsSection title="运行时">
        <SettingsRow
          title="刷新工作台数据"
          description="重新获取 Profile、任务、记忆、技能和审批的最新状态。"
        >
          <BuiButton
            variant="secondary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await refresh();
                return "工作台数据已刷新";
              })
            }
          >
            {action.busy ? "刷新中…" : "刷新数据"}
          </BuiButton>
        </SettingsRow>
      </SettingsSection>
      <SettingsMessage {...action} />
    </>
  );
}
