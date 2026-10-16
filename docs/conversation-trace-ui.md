# 对话执行过程

桌面对话参考用户提供的 TraceDemo，使用 [shadcn Base UI Trace](https://ui.shadcn.com/docs/components/base/trace)、[Collapsible](https://ui.shadcn.com/docs/components/base/collapsible)、[Message](https://ui.shadcn.com/docs/components/base/message)、[Bubble](https://ui.shadcn.com/docs/components/base/bubble) 和 [Code Block](https://ui.shadcn.com/docs/components/base/code-block) 的组件组合。适配后的源码与许可证位于 `apps/desktop/src/ui/`；折叠交互由 `@base-ui/react` 提供。

- 用户消息靠右，工具过程摘要持续可见，每项详情独立展开；输入和输出仅在展开时构造。
- 输入框的待发送图片使用 [shadcn Base Attachment](https://ui.shadcn.com/docs/components/base/attachment)，按用户提供的 AttachmentDemo 组合为竖向卡片：图片在上、原始文件名及格式和实际字节大小在下、移除操作位于卡内右上角；多张图片横向滚动，键盘聚焦会滚动显示当前卡片。文件名只保留在本地草稿显示元数据中，发送仍使用原有附件引用。恢复后没有缩略图的附件使用图标占位，截图和剪贴板图片没有文件名时按来源命名。
- Terminal/Bash、Probe 和 Run Verification 的调用行统一显示状态图标、淡灰命令与展开箭头；Probe 和 Run Verification 同时保留工具名。多行命令仅在摘要中压缩空白，展开后保留原始命令、参数、耗时和输出。失败命令用红色状态图标标记，正文及箭头保持淡灰。
- 审批记录也使用淡灰单行：请求图标、工具名、可解析的顶层命令、风险与箭头。完整 JSON 和截断 JSON 的首个完整 `command` 字符串均可提取；不会从 stdin 脚本中提取伪命令。展开后展示保存的原始审批记录（运行时可能已截断），不将历史请求显示为已批准。
- 读取、命令、审批、操作汇总与来源链接的原生 `title` 提示使用 [shadcn Base Hover Card](https://ui.shadcn.com/docs/components/base/hover-card) 替代。持续悬停或键盘聚焦 1 秒后预览完整路径、命令、耗时或来源地址；快速划过或提前移开会取消本次显示计时。弹层通过 Portal 避开滚动面板裁剪，并根据视口避让。输入、stdin 与输出仍在点击展开的详情中读取；悬停不改变展开状态。
- `tool_started` 与 `tool_finished` 驱动状态和实际耗时。明确的 `isError` 优先于旧日志的错误推断；停止后缺少结果的工具显示“执行已中断”。
- `reasoning_summary` 显示实际摘要。不提供虚构的推理时长；底部“用时”使用运行经过时间并扣除暂停。
- 同轮流式思考摘要连续拼接为一个模块，运行中默认展开，结束后默认收起；模型未返回公开摘要时保留思考状态及说明。私有推理内容不作为公开摘要展示。
- 普通过程对话直接显示 Markdown 正文，保留段落、代码与工具前后的顺序；流式输出和完成后的历史均无需展开。
- 相邻的本地 `read_file/read_range` 调用使用 [shadcn Base UI Marker](https://ui.shadcn.com/docs/components/base/marker) 汇总为一行，默认收起。同文件多片段显示独立文件数和读取次数；展开后保留每次调用的范围、输入和输出。失败、中断与运行进度在收起时也可见，不跨命令、过程文字、用户消息或 MCP 工具合并。
- 相邻的本地读取之外，其余连续的工具调用与其审批行合并为一行摘要：状态图标（完成/运行中/失败/中断）、摘要句与展开箭头持续可见，整行在含失败时转为警示色。摘要句只列出本段出现过的动作，按“编辑了文件，运行了命令”的固定顺序拼接。展开后是原样的每次调用行与审批行，审批仍可单独展开查看保存的原始请求；收起时不构造任何子行。
- “检索到 N 个来源”来自网页搜索或文档访问工具的结构化返回值，校验 HTTP(S) 地址并去重。它不表示最终回答引用了每条结果。历史输出未补齐时显示同步状态。
- 工具跨越用户补充消息时，状态和来源仍归属原工具。用户插话分段、最终回答去重、撤回和续办继续沿用现有逻辑。
- “回放”仅分阶段展示本轮已保存的事件。停止或结束后恢复完整对话，不创建运行、不重新调用工具，也不改写历史。长记录的动画最多 32 步。

验证命令：

```powershell
pnpm typecheck
pnpm lint
pnpm exec vitest run apps/desktop/src
pnpm --filter @harness/desktop build
pnpm --filter @harness/desktop exec cross-env NODE_OPTIONS= electron scripts/conversation-trace-ui-test.cjs
pnpm --filter @harness/desktop exec cross-env NODE_OPTIONS= electron scripts/attachment-ui-test.cjs
```

UI 测试使用隔离的 Electron 数据目录和模拟 IPC，截图及检查结果保存在 `.cache/conversation-trace-ui-*`，不启动真实模型请求。
