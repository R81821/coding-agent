# Harness Web

独立的 Harness 网页工作台。React 19、Vite、Tailwind CSS 4 与 shadcn/ui（Radix primitives）。源码、组件、样式和启动入口都在 `apps/web`，不导入桌面版渲染器、CSS、Electron 或 preload。

## 启动

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @harness/web dev
```

打开 **http://127.0.0.1:5180/**。桌面端仍使用原来的启动方式；网页端使用独立的 5180 端口。

```sh
# 校验与构建
pnpm --filter @harness/web typecheck
pnpm --filter @harness/web test
pnpm --filter @harness/web build

# 本机预览构建产物（先停止 dev，端口同为 5180）
pnpm --filter @harness/web start
```

`start` 使用 Vite preview + 本地连接层，供本机使用，不作为公网部署服务。

## 两种工作模式

### 演示模式（默认）

- 页面始终明确标注演示模式，示例回答不会被冒充为真实模型输出。
- 示例项目、会话和发送记录只保存在浏览器的 `harness.web.demo.v1` 中。
- 可新建项目、发送多轮任务、暂停/继续/停止、搜索和查看任务板。
- 刷新后保留历史；刷新前尚未完成的演示任务会恢复为暂停状态。
- 不调用模型、不访问仓库、不执行命令。

### 连接本地服务

点击右上角 **连接本地服务**，复用已启动且已解锁的 Harness daemon。

- 默认连接 `harness-agent-v2`；可在启动网页前设置 `HARNESS_DAEMON_INSTANCE`，与目标 daemon 保持一致。
- 桌面版每次启动会创建独立的 `desktop_…` 实例。可在 `apps/web/.env.local` 中写入 `HARNESS_DAEMON_INSTANCE=desktop_…`，网页开发服务和构建预览均会读取该配置；此文件不会提交到 Git，也不会打包进浏览器。桌面版重启后需更新实例 ID。启动进程中显式设置的同名环境变量优先。
- 项目路径指的是 **daemon 所在电脑**，浏览器不会弹出 Electron 的目录选择器。
- 网页端不会自动启动/解锁 daemon，不读取或保存模型密钥。模型供应商、凭据、Profile 配置沿用现有运行服务。
- 也可以先单独启动现有 daemon（`pnpm dev:daemon`），按项目原有方式提供运行服务所需环境配置，再启动网页。

浏览器 → 同源 `POST /api/rpc` → 网页连接层 → daemon 命名管道/Unix socket。

已接入：项目与历史会话、Profile 选择、真实任务启动、定时读取会话事件、暂停/继续/停止、执行计划确认、工具审批、每次运行的文件差异、技能和插件列表。

当前边界：任务板展示会话状态；技能/插件是浏览视图；Profile/模型凭据管理、MCP 管理、图片附件、记忆编辑、原生浏览器、定时任务等桌面能力尚未迁入。没有把尚未实现的操作做成虚假成功按钮。运行中先暂停或停止后再发送新任务；当前版本没有网页端中途追加指令功能。

## 界面行为

- 无图标的 Harness 字标；侧栏正文和对话正文统一 14px / 400。
- 项目名称点击折叠，不显示下拉箭头或轮次；任务标题单行省略，状态图标固定在右侧。
- 侧栏滚动槽固定在边缘；窄屏使用 Sheet 抽屉。
- 浅色、深色、跟随系统主题，独立存储于 `harness.web.theme`。
- 中文输入法组合输入不会误发送；Enter 发送，Shift + Enter 换行；Ctrl / Cmd K 搜索。
- 手动向上阅读时不会强制滚到底部；提供回到最新消息按钮。
- 小灰嘎动画显示在每轮生成内容左下方，支持 reduced motion。资源复制到网页目录，无运行时桌面依赖。

## shadcn/ui

`components.json` 已配置，可以在 `apps/web` 中继续按需添加官方组件。
`src/components/ui` 来自官方 `new-york-v4` registry，2026-09-29 获取：

`https://ui.shadcn.com/r/styles/new-york-v4/<component>.json`

使用 Button、Badge、Card、Dialog、Input、Textarea、Select、Tabs、Collapsible、Dropdown Menu、Tooltip、Sheet 等；调整为相对导入和严格可选属性兼容。`cn()` 采用 clsx + tailwind-merge。上游许可见 `SHADCN-LICENSE`。

样式变量完全属于网页端，使用 shadcn 的语义色彩。没有加载或覆盖 `apps/desktop` 的主题变量。

## 本地连接边界

仅监听 `127.0.0.1`，校验 Host / Origin / JSON 类型和自定义请求头；不开放 CORS。RPC 使用协议 schema 验证和明确的允许列表，不提供通用无限制代理。限制请求大小、响应大小与超时。新增项目指令在确认后才调用 `project.trust`。

要支持远程访问或公网部署，需要另外设计身份验证、授权、传输加密与服务部署；不要简单改成 `0.0.0.0`。

## 验证

- 连接层测试：同源正常请求、跨源和伪造 Host 拒绝、非法参数/方法/过大请求、daemon 失败、分块 UTF-8 响应、请求 ID 校验、超时。
- 会话测试：最终答案去重、演示任务完整生命周期、暂停/继续/停止、历史恢复。
- 浏览器检查：项目折叠、发送演示任务、主题切换、390px 手机布局、导航抽屉、搜索、本地服务连接错误。

真实模型调用需有可用 daemon 和模型配置；测试不自动执行用户仓库中的真实开发任务。
