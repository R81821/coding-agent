# Harness Agent

Harness Agent 是面向 Windows 11 x64 的本地优先软件开发 Agent。它把桌面端、`harness-agent` CLI、远程消息和定时任务连接到同一个独立 daemon，并以追加式 `RunEvent` 日志保存可恢复、可审计的运行状态。

当前版本为 `1.2.1`。图片仅用于理解、OCR、截图分析和多图比较；不包含图片生成或编辑。附件、网页、项目指令和工具输出默认是不可信数据，不能覆盖当前用户请求或取得更高工具权限。

核心多轮循环使用 `@earendil-works/pi-agent-core`，负责流式消息、工具批次、轮次生命周期和取消传播。Harness 适配层继续掌管 provider 路由、确定性权限与审批、不可信数据标记、预算、事件落库、记忆和最终验证，因此 pi-agent 不能绕过现有安全边界。

## 已实现范围

- 严格 TypeScript + pnpm monorepo；Electron/React/Vite 桌面端和 Windows NSIS 安装器。
- Named pipe daemon、流式 Run 状态机、取消/恢复/审批/预算/验证和未提交 Git diff。
- OpenAI Responses、Anthropic Messages、Gemini 和 OpenAI-compatible provider；按视觉、工具、数据策略、质量、成本、延迟和健康状态路由。
- 受限文件读写、搜索、补丁、PTY 命令、Git diff、隔离浏览器 profile 与 Chromium DevTools 自动化。
- AES-256-GCM 加密 SQLite/附件库，Argon2id 口令派生；长期记忆候选需显式批准。
- `SKILL.md` 哈希信任、`AGENTS.md` 首次预览与变更后重新确认。
- 独立 Git worktree 子任务、最多 1–8 并发、脏工作区内部快照与非 Git 降级。
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

安全模型、威胁边界和密钥处理见 [SECURITY.md](./SECURITY.md)。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

测试默认全部使用模拟 provider，不会意外调用真实 API；只有显式提供集成测试凭据时才应运行真实 provider 测试。
