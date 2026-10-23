# 历史写入回执显示修复

日期：2026-10-21。

用户截图中的 `server/marketData.ts` 写入实际成功。通过当前 daemon 的只读 `session.view`、`run.eventPage`、`run.output` 接口确认：写入 9830 字节，新增 315 行、删除 0 行，保存的差异共 10206 字符且完整。

## 根因

实时事件中的回执是对象；历史事件先返回 deferred 引用，再由 `SessionContentLoader` 将 `run.output` 的多页文本拼成完整 JSON 字符串。`appliedToolChanges` 原先只接收对象，因此误将成功回执判为不可确认。

上一轮 Electron 测试直接传入对象，没有经过这个历史加载流程，漏测了格式转换。本次先用旧构建与真实分页协议复现同样错误，保留 `before-failure.png`、`before-failure.json`。

## 修复

在变更面板消费回执时，同时支持对象和完整 JSON 对象字符串。继续拒绝损坏 JSON、数组、null、未加载完成、失败回执与远端同名工具，也不把输入代码当成写入证明。不修改数据库和通用历史输出格式。

## 验证

- 相关回归：49 个文件、413 项测试通过；包括对象与文本回执一致性、实际分页加载完成前不显示成功、完成后恢复面板。
- TypeScript、修改文件 ESLint、桌面端构建通过。
- 最终构建的 Electron 界面：131 项检查通过，见 `result.json`。测试改为 deferred 事件加分页 JSON 输出，保留复制、失败状态、展开收起、滚动和窄窗口检查。
- 用户真实记录解析结果见 `actual-receipt-verification.json`。
- 将这条真实回执放入隔离的最终 Electron 渲染器，经 22 页 JSON 输出加载后确认 315 条绿色新增行及 0 条删除行，见 `actual-renderer-verification.json` 与 `actual-marketData-restored.png`。截图来自隔离验证界面；未改动用户会话、数据库或项目文件。

刷新或重新打开更新后的前端会话即可恢复已有回执，无需重新执行 Agent 任务。
