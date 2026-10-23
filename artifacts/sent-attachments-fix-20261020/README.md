# 已发送截图显示修复

日期：2026-10-20。

根因：上传接口和数据库已保存图片，发送成功后草稿预览被清空；SessionTurn 没有保留附件引用，用户消息气泡只渲染文字。历史加载同样没有图片读取与渲染路径。

修复：完整和预览历史行都保留附件，消息中显示图片及文件名；图片支持点击放大、Escape 关闭、加载失败后重试。新 attachment.preview 接口按 runId/attachmentId 校验消息归属，从数据库可信引用读取加密图片，并检查可见会话、图片类型、大小与哈希；前端不传入文件路径。

实际验证：

- 10 个相关测试文件、148 项测试通过，日志 [unit-tests.log](D:/qweai/artifacts/sent-attachments-fix-20261020/unit-tests.log)。
- 生产构建的 Electron renderer：88 项 UI 检查通过，无 renderer 异常；[结果 JSON](D:/qweai/artifacts/sent-attachments-fix-20261020/electron-ui-result.json)。
- 验证选择图片、ClipboardEvent 粘贴导入、发送后显示、无草稿预览图片恢复、切会话、整页 reload 历史恢复、混合普通文件、图片放大与 Escape。
- desktop 和 daemon 构建通过；TypeScript 检查、改动文件 ESLint、git diff --check 通过。UI 测试使用隔离 Electron 数据目录和受控 IPC；附件后端另有真实加密数据库重开测试。

边界：现有 run.steer 只支持文字。带图片的运行中或暂停任务追加消息现在会明确报错并保留整份草稿，不会静默只发送文字。可等待任务结束，或新建会话发送图片。该修复没有扩展 steering 为多模态协议。

桌面端和 daemon 的源码及构建已更新，已有运行进程需重新启动更新后的构建才能加载此修复。

截图：

- [发送后图片](D:/qweai/artifacts/sent-attachments-fix-20261020/sent-attachments.png)
- [点击放大](D:/qweai/artifacts/sent-attachments-fix-20261020/sent-attachments-preview.png)
- [重新加载后的历史图片](D:/qweai/artifacts/sent-attachments-fix-20261020/history-attachments-reload.png)
- [历史中的图片与普通文件](D:/qweai/artifacts/sent-attachments-fix-20261020/history-attachments-mixed-reload.png)
- [追加附件提示与保留草稿](D:/qweai/artifacts/sent-attachments-fix-20261020/sent-attachments-followup-guard.png)
