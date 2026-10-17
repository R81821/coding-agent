# Agent 回复的 Markdown 渲染

桌面端的 `MarkdownMessage` 使用 Streamdown，代码高亮使用 `@streamdown/code` 的 Shiki 插件，中文标点与强调由 `@streamdown/cjk` 处理。渲染入口位于 `apps/desktop/src/markdown-message.tsx`，排版统一放在同目录的 `markdown-message.css`。

## 实时回复与历史内容

- 仍在生成的正文和思考摘要传入 `isStreaming`，启用分块更新和未闭合语法修复；未完成的链接保持不可点击。
- 已完成、暂停或中断的内容使用静态模式，保留未闭合 Markdown 的原始含义，不继续补全。
- 跨段参考链接或脚注出现定义时使用完整解析树，保证引用与定义相连。
- `compact` 用于过程对话和思考摘要，保留紧凑排版，不显示整条回复的操作栏。

## 外观与交互

普通正文采用界面偏好字号加 1px，行距 1.8；过程内容使用界面字号和 1.7 行距。对话中的用户消息、模型回复、执行过程和输入框共用居中、最大 820px 的阅读列；回复内部占满该列，不再单独限宽。用户气泡只在列内靠右，正文仍左对齐。窄窗口保留自适应边距，滚动条对称预留空间，避免内容列偏移。对话外的技能等内容保留 78ch 的阅读上限。

正文、代码字体及字重继续跟随外观偏好。代码 token 同时保留明暗配色，通过 `data-appearance-tone` 切换，不依赖操作系统主题。

代码高亮异步加载并取消过时结果。未知语言或超过 50,000 字符的代码块使用纯文本，复制内容始终来自原始代码。代码与宽表格在各自容器内横向滚动。

外链仍通过桌面端的 `openExternal` 打开，并只接受不含凭据的 HTTP(S) URL；图片保持链接占位，不自动请求远端资源。原始 HTML 不参与渲染，HTML 代码块作为普通代码展示。复制与查看原文保留完整 Markdown。

## 验证

```powershell
pnpm exec vitest run apps/desktop/src/markdown-message.test.tsx apps/desktop/src/components/ConversationTrace.test.tsx
pnpm --filter @harness/desktop build
pnpm --filter @harness/desktop exec electron scripts/markdown-ui-test.cjs
```

UI 测试使用隐藏窗口、独立临时用户目录与模拟 IPC，不启动 daemon 或真实模型，也不修改系统剪贴板。截图及验证结果保存在 `.cache/markdown-ui-*`，涵盖明暗高亮、窄屏滚动、原文切换、复制、外链失败重试和流式转静态显示。
