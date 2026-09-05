# Harness Agent 桌面端 UI 全量重写设计

日期：2026-09-02
目标：用 Beautiful UI（beautifului.dev，MIT）的 Agent 组件语言全量重写桌面端 10 个视图，提升展现效果。
已确认决策：
- 范围：全量重写所有视图（聊天、任务、审批、计划、记忆、技能、插件、Profile、追踪、设置）。
- 风格：深色玻璃拟态（延续 #061425 底色）+ Beautiful UI 蓝色调中性色组件语言。不做亮色主题。
- 图标：lucide-react（ISC 免费、tree-shake、stroke 风格）替换全部图标，含 SidebarNav（原 Beautiful UI 付费 @central-icons-react 不引入）。
- 逻辑层零改动：IPC 白名单、状态管理、事件流、审批流、daemon 通信全部保留，只替换 JSX 展示层。
- 中文 UI 文案保留。

## 技术路线

1. 引入 Tailwind CSS v4（`@tailwindcss/vite` 构建期插件，无运行时脚本；CSP `style-src 'self' 'unsafe-inline'` 已允许内联样式，兼容）。
2. `apps/desktop/src/tailwind.css`：`@import "tailwindcss"` + `@theme` 深色玻璃 token（背景/表面/描边/文字/蓝强调/语义色、系统中文字体栈、代码字体栈、shimmer 等 keyframes）。
3. `apps/desktop/src/ui/`：基础组件（Button/Card/Badge/ToolChip/LoadingState 等）按 Beautiful UI 设计语言实现（Tailwind class，非复制其 Next.js 源码——本机网络受限时手写等价实现，行为与视觉对齐公开文档）。
4. 视图分批替换，旧 `styles.css` 在最后一批删除。

## 组件映射

| Beautiful UI 组件 | 用于 Harness Agent |
|---|---|
| Chat / Streaming Text / Reasoning | 聊天消息流（thinking 可折叠） |
| Thinking / Task Rows / Tool Chips | 工具调用时间线（tool_started→finished 映射步骤状态） |
| Approval Card | 工具审批 + 计划审批（风险色、参数摘要、批准/拒绝/要求修订） |
| Prompt Bar | 输入栏（@附件、/命令、模型选择器；保留 IME 防误发逻辑） |
| Loading State | 运行中加载态（像素网格 shimmer + 经过时间） |
| Context Cards | 附件卡片、记忆检索上下文 |
| Records / Filter Table | Trace 视图、审计列表 |
| 手绘（统一 token） | Kanban、Memory/Skills/Plugins/Profiles/Settings |

## 分批交付（每批独立验证）

1. 基础设施：Tailwind v4 + token + lucide-react + ui/ 基础组件 + SidebarNav 改造（首个可见效果）。
2. Chat 主界面：消息流 + 工具时间线 + PromptBar + 附件 + 加载态。
3. 审批与计划：审批卡片、计划视图、截图裁剪浮层。
4. 管理视图：Tasks(Kanban)、Memory、Skills、Plugins。
5. 收尾：Profiles/验证编辑器、Trace、Settings；删除 styles.css；全量回归。

## 验收

每批：`corepack pnpm typecheck` + `corepack pnpm test`（72 项全绿不回归）+ `corepack pnpm -r --if-present build` 通过；视觉部分由用户 `pnpm dev` 验收（我无法直接查看 Electron 渲染）。
