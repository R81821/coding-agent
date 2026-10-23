# Harness Agent

Harness Agent 是面向 Windows 11 x64 的本地优先软件开发 Agent。它把桌面端、`harness-agent` CLI、远程消息和定时任务连接到同一个独立 daemon，并以追加式 `RunEvent` 日志保存可恢复、可审计的运行状态。

当前版本为 `1.4.52`。图片仅用于理解、OCR、截图分析和多图比较；不包含图片生成或编辑。附件、网页、项目指令和工具输出默认是不可信数据，不能覆盖当前用户请求或取得更高工具权限。

核心多轮循环使用 `@earendil-works/pi-agent-core`，负责流式消息、工具批次、轮次生命周期和取消传播。Harness 适配层继续掌管 provider 路由、确定性权限与审批、不可信数据标记、预算、事件落库、记忆和最终验证，因此 pi-agent 不能绕过现有安全边界。

## 已实现范围

- 严格 TypeScript + pnpm monorepo；Electron/React/Vite 桌面端和 Windows NSIS 安装器。
- Named pipe daemon、流式 Run 状态机、取消/恢复/审批/预算/验证和未提交 Git diff。
- OpenAI Responses、Anthropic Messages、Gemini 和 OpenAI-compatible provider；按视觉、工具、数据策略、质量、成本、延迟和健康状态路由。
- 受限文件读写、搜索、补丁、PTY 命令、Git diff、隔离浏览器 profile 与 Chromium DevTools 自动化。
- AES-256-GCM 加密 SQLite/附件库，Argon2id 口令派生；长期记忆候选需显式批准。
- 持久化多轮 Session：同一会话的每条消息保留独立 run，并在上下文预算内续接历史；会话按项目归档。
- 最新未完成轮次暂停后可撤回：恢复发送前的文件状态并将原消息、附件放回输入框；完成轮次不可撤回。
- 会话与项目支持软删除和设置页恢复；只有已删除会话可永久清理运行历史，长期记忆始终保留，项目删除绝不触碰磁盘仓库。
- `SKILL.md` 哈希信任、`AGENTS.md` 首次预览与变更后重新确认。
- 独立 Git worktree 子任务、最多 1–8 并发、脏工作区内部快照与非 Git 降级。
- 单对话加密持久任务队列、跨批次空槽补位、事件等待、独立验收和有界只读工具并行。
- Kanban、五段 Cron、Asia/Shanghai 默认时区、重启恢复和无人值守预授权。
- Telegram Bot API、飞书长连接、一次性配对、图片输入、远程审批和摘要输出。
- PostgreSQL 团队 Gateway：设备配对、加密 BYOK、模型白名单、预算和仅元数据审计。
- 本地 trace、token/费用统计、Profile、权限中心和中文优先 UI。

## 环境要求

- Windows 11 x64
- Node.js 22.19+
- pnpm 10+
- 可选：Git、Docker Desktop、Microsoft Edge 或 Google Chrome

## 快速开始

```powershell
pnpm install
Copy-Item .env.example .env
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

至少配置一个 provider。以 OpenAI 为例：

```powershell
$env:OPENAI_API_KEY = "..."
$env:HARNESS_APP_PASSPHRASE = "使用一个长且唯一的本地保险库口令"
pnpm dev:daemon
```

另开一个终端：

```powershell
pnpm dev:cli doctor
pnpm dev:cli chat D:\path\to\repo
```

桌面开发模式：

```powershell
pnpm dev
```

开发启动会等待本次主进程、预加载构建和 Vite 服务全部就绪，再打开窗口，终端会显示准备进度。文件监听只覆盖源码，避免遍历依赖、安装包和构建缓存。后续构建会原子替换完整文件，避免加载写到一半的代码；主进程改动需退出应用并重新运行 `pnpm dev` 后生效（关闭窗口只会隐藏到托盘）。如需更换开发端口，可用 `HARNESS_DESKTOP_DEV_PORT` 指定端口（默认 5173）。

桌面端可在“设置 → 兼容 API”中填写 OpenAI-compatible 服务的 `Base URL` 和模型 ID；API Key 仍在同页的 Windows 凭据中以 `OPENAI_COMPATIBLE_API_KEY` 保存。保存后 daemon 会自动重载，两项同时清空即可禁用该 provider。

生产安装包：

```powershell
pnpm build
pnpm --filter @harness/desktop package
```

安装器写入 `apps/desktop/release/`。桌面端首次启动会要求解锁本地保险库，随后托盘和 daemon 在关闭主窗口后继续运行。

## CLI

构建后可执行 `node apps/cli/dist/main.js <command>`；发布安装时命令名为 `harness-agent`。

```text
harness-agent chat [workspace]
harness-agent run <workspace> <prompt> [--attach image.png]
harness-agent resume <run-id>
harness-agent tasks
harness-agent cron
harness-agent profiles
harness-agent skills
harness-agent memory
harness-agent gateway
harness-agent doctor
```

交互模式支持 `/model`、`/profile`、`/attach`、`/delegate`、`/cancel`、`/compact` 和 `/exit`。

## 图片信任边界

图片在上传前验证真实 MIME、尺寸和大小，并通过 Sharp 重新编码以移除 EXIF。UI 会显示缩略图、目标 provider/model 和确认步骤；加密原始副本只保留在本机。OCR 文本和视觉结论始终带 `untrusted_attachment` 标签。只有用户显式选择“作为指令使用”后，附件内容才能进入较高但仍受策略引擎约束的信任层。

## 项目指令与技能

项目首次打开时会预览 `AGENTS.md` 并记录 SHA-256。文件内容改变后自动失效，需要重新确认。仓库技能放在 `.agent/skills/<name>/SKILL.md`，用户技能放在应用数据目录的 `skills/` 下。

最小技能示例：

```markdown
---
id: verify-typescript
name: Verify TypeScript
version: 1.0.0
description: Run repository TypeScript verification.
triggers: [typecheck, typescript]
tools: [terminal]
pathGlobs: ["**/*.ts", "**/*.tsx"]
networkDomains: []
compatibility: ">=1.0.0-beta.1"
---

先检查 package scripts，再运行仓库声明的 typecheck 命令。不要修改文件。
```

技能草案在写入和启用前会展示内容、diff 与权限变化；技能只能缩小当前权限或触发新的审批。

## 自托管 Gateway

```powershell
$env:GATEWAY_MASTER_KEY = "至少 32 字符的部署主密钥"
$env:GATEWAY_ADMIN_KEY = "独立的管理员密钥"
docker compose up --build
```

Gateway 默认监听 `http://127.0.0.1:8787`。管理员先调用 `/admin/providers` 配置加密的上游密钥，再创建 `/admin/pairing-codes`；设备通过 `/v1/pair` 换取可撤销 token。Gateway 默认只保存用量与审计元数据，不保存 prompt、图片或代码。

## 数据与运行目录

默认数据位于 `%LOCALAPPDATA%\HarnessAgent`。开发和自动化环境可通过 `HARNESS_APP_DATA_PATH` 覆盖；远程 Telegram/飞书任务必须显式设置 `HARNESS_REMOTE_WORKSPACE`。本地数据库、事件、记忆和附件均以保险库主密钥加密。

会话创建、上下文续接、删除/恢复与永久删除边界见 [Session 生命周期](./docs/session-lifecycle.md)。

暂停后的消息撤回与文件恢复见 [聊天撤回](./docs/conversation-withdrawal.md)。

单对话任务队列由 daemon 内的 SQLite 管理。主模型用 `run_tasks` 提交计划节点，立即获得任务 ID；用 `wait_tasks` 等待进展，检查产物后用 `integrate_tasks` 确认集成，最后在父对话运行真实测试。子任务完成不会自动验证节点或解锁依赖。会话内的任务面板显示排队、阻塞、执行、待集成及失败原因；未启动项可取消，失败或中断项需提供检查产物后的原因才能重试。暂停会停止派发并等待已启动操作安全结束；重启后的未知执行需要检查，不能自动重放。

四个独立环境变量控制资源：`HARNESS_TASK_CONCURRENCY`（默认 4，范围 1–8）、`HARNESS_TASK_QUEUE_LENGTH`（默认 80，范围 1–10000）、`HARNESS_TOOL_CONCURRENCY` 和 `HARNESS_MODEL_CONCURRENCY`（默认均为 4，范围 1–32）。每次 `run_tasks` 提交最多 8 个节点，可连续提交多批；单次提交上限与整个队列容量独立。`run_tasks.maxParallel` 可以进一步降低本轮任务并发。队列满时明确报错；这些配置不改变模型上下文容量、输出上限或摘要策略。工具并行仅用于运行时确认的幂等只读实现；浏览器、外部 MCP 和共享写操作继续串行。旧版嵌入式引擎若未提供队列执行器，保留原同步委派协议。

可复现的并发测试和性能边界见 [任务队列性能记录](./docs/superpowers/plans/2026-10-15-conversation-task-queue-performance.md)。

安全模型、威胁边界和密钥处理见 [SECURITY.md](./SECURITY.md)。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

测试默认全部使用模拟 provider，不会意外调用真实 API；只有显式提供集成测试凭据时才应运行真实 provider 测试。
