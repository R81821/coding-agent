# MCP、项目任务与技能协同实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部 MCP 真正参与项目对话、定时任务、恢复执行及技能驱动的工作，并提供可操作的桌面管理界面。

**Architecture:** 标准 MCP SDK 负责协议和传输；扩展层负责加密配置、连接生命周期、项目隔离；核心引擎按运行解析能力并复用现有审批、证据和预算。桌面仅通过类型化 RPC 操作公开视图，不持有后台凭据。

**Tech Stack:** TypeScript、Zod、SQLite 加密记录、MCP 官方 TypeScript SDK、React、Vitest、Electron。2026-09-23 npm 查询 SDK 稳定版本为 1.30.0，要求 Node >=18；项目要求 Node >=22.19.0。

**Spec:** `docs/superpowers/specs/2026-09-21-mcp-task-skill-design.md`

## Global Constraints

- 保留当前工作区既有修改，不从 HEAD 新建一个遗漏这些修改的实现基线。
- 页面存在或单独连接成功不构成完成。
- 未知结果的写操作不得自动重试，checkpoint 恢复不得重复执行。
- 列表 RPC 不返回 secret 值，编辑用“保留 / 替换 / 清除”语义。
- 手动对话、暂停恢复、定时任务、远程入口和委派任务使用同一能力解析入口。
- 用户明确的项目授权才可让外部工具成为只读能力；远端 annotations 不能授予权限。
- 每步先用有实际行为断言的测试复现缺失，再实现；不重写现有 UI、评审或预算功能。

## Review Focus

1. 两个项目使用同一 MCP 服务：连接的 cwd/roots、缓存和工具授权不得串项目（任务 2、4）。
2. 更新、禁用、删除与连接建立同时发生：旧连接不能重新注册或执行工具（任务 2、4）。
3. 密钥编辑省略字段与空字符串：省略保留、null 删除、给值替换；公开列表及错误不可回显（任务 1、3）。
4. 工具目录超过一页、名称冲突或执行中变化：分页读全、稳定命名、当前运行冻结版本（任务 2、4）。
5. 网络错误后不确定是否已完成写入：不得重放，取消和恢复有明确状态（任务 2、4、7）。

## 接口与文件边界

| 文件 | 职责 |
| --- | --- |
| `packages/protocol/src/mcp.ts` | 配置、公开视图、工具策略、连接状态及运行快照类型 |
| `packages/persistence/src/database.ts` | 加密 MCP 记录的增查删；沿用现有 AAD 与加密流程 |
| `packages/extensions/src/mcp-store.ts` | 配置校验、secret patch、项目路径规范化、修订号与公开视图 |
| `packages/extensions/src/mcp-client.ts` | SDK transport、分页目录、工具调用、roots、连接关闭 |
| `packages/extensions/src/mcp-service.ts` | 按项目管理连接、版本撤销、工具清单与能力租约 |
| `packages/extensions/src/mcp-oauth.ts` | OAuth provider、回调、token 刷新及退出 |
| `packages/core/src/mcp-capabilities.ts` | 运行准备、工具适配、权限、证据及快照恢复 |
| `packages/core/src/skill-runtime.ts` | 可信技能目录、按需加载和工具依赖诊断 |
| `apps/daemon/src/mcp-rpc.ts` | 管理接口；由现有 dispatch 调用 |
| `apps/desktop/src/components/McpView.tsx` | 服务配置、项目绑定、目录和状态 |
| `tests/fixtures/mcp-server.mjs` | SDK 实际 stdio 服务，支持 roots、分页、错误、延迟与计数 |

## Task 1: 可持久化的服务配置

**Files:** 新建协议和 mcp-store；修改协议导出、数据库与扩展导出；新建 `tests/mcp-store.test.ts`。

**Interfaces:**

```ts
type McpTransport =
  | { type: "stdio"; command: string; args: string[]; cwd?: string }
  | { type: "streamable_http" | "sse"; url: string };
interface McpServerConfig {
  id: string; name: string; revision: number; enabled: boolean;
  transport: McpTransport; projectPaths: string[]; readOnlyTools: string[];
  env: Record<string, string>; headers: Record<string, string>;
  connectTimeoutMs: number; callTimeoutMs: number;
}
interface McpServerView extends Omit<McpServerConfig, "env" | "headers"> {
  envKeys: string[]; headerKeys: string[];
}
// McpServerInput omits revision and stored env/headers; secret patches accept string|null.
// expectedRevision is required when editing and checked against the stored record.
// McpStore.save(input: McpServerInput): Promise<McpServerView>
// McpStore.list(): McpServerView[]; get(id: string): McpServerConfig | undefined
// McpStore.remove(id: string, expectedRevision: number): void
```

- [ ] 写加密数据库 fixture，用 `McpStore.save` 保存 HTTP token 和项目绑定，重开数据库后读取；断言公开 JSON 不包含 token，磁盘文件不含 token 字节。
- [ ] 测试省略 secret 保留、null 删除、修订号过期拒绝；非法 transport/url/header 和相对项目路径拒绝；不同大小写 Windows 项目路径去重。
- [ ] 运行 `pnpm exec vitest run tests/mcp-store.test.ts`，确认因模块缺失而失败。
- [ ] 实现 schema、数据库表及 store。存储调用现有 `upsert("mcp_servers", id, config)`；公开视图只返回 secret 的 key。写入先校验并规范化项目路径，再原子保存新 revision。

```ts
const applySecretPatch = (previous: Record<string, string>, patch: Record<string, string | null> = {}) => {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]; else next[key] = value;
  }
  return next;
};
```

- [ ] 运行该测试及 `pnpm typecheck`；记录改动和通过证据，不把其他工作区修改纳入提交。

## Task 2: 真实 SDK 连接与工具目录

**Files:** 新建 mcp-client、mcp-service、stdio fixture、`tests/mcp-client.test.ts` 与 `tests/mcp-service.test.ts`；扩展包增加 SDK 依赖。

**Interfaces:**

```ts
interface McpConnection {
  listTools(signal: AbortSignal): Promise<import("@modelcontextprotocol/sdk/types.js").Tool[]>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>;
  close(): Promise<void>;
}
// connectMcp(config: McpServerConfig, workspacePath: string, signal: AbortSignal): Promise<McpConnection>
// McpService.connect(id: string, workspacePath: string, signal: AbortSignal): Promise<McpConnection>
// McpService.invalidate(id: string): Promise<void>; close(): Promise<void>
```

- [ ] 启动真实 Node stdio 测试服务，工具 `echo` 返回参数和 roots；测试握手、分页、调用、isError、超时和取消。再用 SDK HTTP 服务在临时 loopback 端口执行相同调用断言。
- [ ] 运行 `pnpm exec vitest run tests/mcp-client.test.ts tests/mcp-service.test.ts` 确认缺失行为。
- [ ] 安装锁定的 SDK，实现三种显式 transport；命令和参数分开传入，Windows 子进程无可见窗口，拒绝把 stdout 日志当作有效 RPC。

```ts
const client = new Client({ name: "harness-agent", version: "1.4.3" }, { capabilities: { roots: { listChanged: true } } });
client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspacePath).href, name: basename(workspacePath) }] }));
await client.connect(transport, { signal, timeout: config.connectTimeoutMs });
const result = await client.callTool({ name, arguments: input }, CallToolResultSchema, { signal, timeout: config.callTimeoutMs });
```

- [ ] 分页循环记录已见 cursor，重复 cursor/重复工具名返回目录错误；关闭失败连接，保存状态但不回显 env/header。
- [ ] 连接 key 包含 server id、revision 和真实项目路径；连接中失效用 generation 防止旧 promise 重新加入池。禁用/删除取消本服务在途调用。
- [ ] 并发 A/B 项目验证 roots/cwd 不交叉；更新或取消时确认旧进程退出、旧工具不得调用。运行相关测试。

## Task 3: 认证和管理 RPC

**Files:** mcp-oauth、mcp-rpc、daemon dispatch、renderer IPC allowlist、协议；`tests/mcp-rpc.test.ts` 和 `tests/mcp-oauth.test.ts`。

**Interfaces:** RPC `mcp.list`, `mcp.save`, `mcp.remove`, `mcp.connect`, `mcp.disconnect`, `mcp.tools`, `mcp.import`, `mcp.auth.start`, `mcp.auth.logout`。连接/工具接口都要求 `workspacePath`，编辑/删除要求 `expectedRevision`。

- [ ] 测试非法 renderer 方法拒绝；公共读取无密钥；mcpServers 导入只生成预览配置、不启动命令。
- [ ] 使用本地 OAuth 测试服务验证 PKCE/state、错误回调拒绝、超时、刷新和退出后失效；token 仅保存在加密记录。
- [ ] 运行 `pnpm exec vitest run tests/mcp-rpc.test.ts tests/mcp-oauth.test.ts`。
- [ ] 实现 SDK OAuthClientProvider 适配与回环回调；认证 job 返回可打开 URL，由桌面用户操作触发。登录取消关闭监听，token 过期刷新；401 不切换匿名或旧传输来绕过认证。

```ts
switch (request.method) {
  case "mcp.list": return runtime.mcp.store.list();
  case "mcp.save": {
    const view = await runtime.mcp.store.save(request.params);
    await runtime.mcp.invalidate(view.id);
    return view;
  }
}
```

- [ ] 连接状态公开化（disabled/disconnected/connecting/connected/auth_required/error），状态不依赖应用启动等待全部服务在线；运行测试和类型检查。

## Task 4: 运行能力、审批和恢复

**Files:** mcp-capabilities、engine、runtime、protocol 的 RunSpec 扩展；`tests/mcp-runtime.test.ts`。

**Interfaces:**

```ts
interface RunCapabilityLease {
  tools: ToolDefinition[];
  snapshot: Array<{ serverId: string; revision: number; toolName: string; contractHash: string }>;
  close(): Promise<void>;
}
// prepareMcpCapabilities(spec: RunSpec, profile: Profile, signal: AbortSignal): Promise<RunCapabilityLease>
// EngineDependencies.prepareCapabilities?: typeof prepareMcpCapabilities
```

- [ ] 可控模型 + 真 stdio 服务完成一次 engine 工具往返；普通对话、调度、子任务和恢复逐个验证走统一准备入口。
- [ ] 红色测试：相同工具原名来自两个服务、项目未授权、只读注解伪装写工具、审批拒绝零执行、已禁用工具不能复用、恢复时 revision/schema 变化拒绝、未知写结果不重放。
- [ ] 引擎在执行前获取按运行能力租约；将工具定义交给该运行 registry overlay，不全局注册项目工具。`authorizeTool` 接受当前运行的定义，不能因工具只存在于运行集合而绕过授权。

```ts
const risk = config.readOnlyTools.includes(remoteTool.name) ? "read" : "high";
const definition: ToolDefinition = {
  contract: { name: namespacedName, description: remoteTool.description ?? remoteTool.name, inputSchema: remoteTool.inputSchema, risk, idempotent: risk === "read", timeoutMs: config.callTimeoutMs },
  execute: async (input, context) => {
    const result = await connection.callTool(remoteTool.name, input, context.signal);
    return { output: result, isError: result.isError === true };
  },
};
```

- [ ] 保存运行快照并在恢复检查；任务执行 finally 关闭租约，runtime.close 等待引擎取消与连接清理；子任务权限是父运行能力的交集。
- [ ] 文本和 structuredContent 保存证据；图片/音频存 blobs 后以类型化引用传递；大目录提供搜索/加载工具且实际调用仍经过同一审批管线。
- [ ] 运行 `pnpm exec vitest run tests/mcp-runtime.test.ts tests/loop-control.test.ts tests/workflow-engine.test.ts`。

## Task 5: 技能发现和 MCP 联动

**Files:** skill-runtime、engine/context、SkillService；`tests/mcp-skill-integration.test.ts`。

**Interfaces:** 按运行生成可信技能目录；`load_skill({key})` 返回该已信任来源的正文和资源路径；运行快照记录已加载 skill key/hash，不允许目录文本授予工具权限。

- [ ] 项目技能正文明确要求查询 MCP `project_status` 后给出结论；可控模型断言实际收到技能、目录和结果，真实服务计数证明调用发生。
- [ ] 测试同名全局/项目技能、内容变更、未信任文件、取消、压缩后规则保留、恢复冻结引用和缺失依赖提示。
- [ ] 实现选择优先级：运行冻结引用 > 会话显式选择（含空集合）> Profile；仅对已信任技能提供自动发现目录，正文通过选择或 load_skill 加载。

```ts
const selected = resolveSelectedSkills(spec.skillSelection ?? profile.skillIds, documents, spec.skills);
const catalog = documents.filter(doc => doc.manifest.enabled).map(doc => ({ key: doc.key, name: doc.manifest.name, description: doc.manifest.description }));
```

- [ ] 资源脚本路径以技能目录为基准，执行仍走现有工具权限；运行 `pnpm exec vitest run tests/mcp-skill-integration.test.ts tests/skill-selection.test.ts tests/skill-session-integration.test.ts`。

## Task 6: 桌面管理和任务可见性

**Files:** McpView.tsx、mcp.css、renderer、tool-summary；新增组件行为测试。

- [ ] 组件测试覆盖配置错误、secret 保留/清除、项目选择、pending 防重复、连接失败重试、工具授权和导入预览。
- [ ] 插件页分为本地插件与 MCP；MCP 服务卡显示传输、项目、连接状态、工具数、授权、编辑和启停。当前项目来自已有 workspace 状态。

```tsx
<McpView workspacePath={workspace} request={window.harness.request} />
```

- [ ] 通过受控表单将空 secret 输入解释为保留，明确清除操作提交 null；错误显示靠近操作控件，不只输出 console。
- [ ] 对话工具记录显示原名与服务来源、耗时和证据；任务入口显示实际启用的 MCP 和技能及失败诊断。
- [ ] 运行组件测试并在真实 Electron/预览页操作新增 → 连接 → 绑定项目 → 调用 → 禁用，检查屏幕与键盘交互。

## Task 7: 完整验收与接入指南

**Files:** `docs/mcp.md`、端到端 fixtures、审计记录。

- [ ] 真实 stdio、Streamable HTTP、SSE 与 OAuth 测试服务分别连接；断线、超时、取消、目录更新和认证续期有可复现结果。
- [ ] 同时在 A/B 项目执行技能驱动任务：服务收到正确 roots 与参数，未经授权的项目和子任务零调用；定时执行和恢复具有相同结果。
- [ ] 检查多媒体证据、大工具目录按需加载、未知写结果不重试以及禁用后连接清理。
- [ ] 执行以下验证并读取所有失败详情，只有当前变更或发现的实质问题才触发重复验证：

```powershell
pnpm typecheck
pnpm exec vitest run
pnpm build
```

- [ ] 更新接入指南：命令/参数/环境变量示例，HTTP token 与 OAuth 配置，项目绑定，技能示例与诊断方式；示例无真实凭据。
- [ ] 独立审查整个 MCP 变更并修复实质问题；逐条对照 spec 保存证据。完成全部七项后才能将用户目标标为 complete。

## 执行记录

- 2026-09-23：重新核对基线 HEAD `65ec093`；已有新的未提交 UI/运行评审修改。此前 453 项通过是 09-22 基线证据，不冒充当前工作区全量验证。
- SDK 元数据只读查询成功：1.30.0，Node >=18。随后开始安装锁定版本用于真实传输测试。
- 执行方式：建议在当前任务内逐层实现，完成后一次独立整体审查。任务间按接口顺序执行，保留已有工作区改动。
- Ruling: 根据恢复后的继续目标指令，在当前任务内执行可逆的实现和验证，不再为常规代码步骤反复请求权限；此前等待审阅不再作为重复空转的理由。产品行为范围仍以原设计为准，发布与外部账户操作另行按具体授权处理。
- Ruling: 原工作区为 `codex/upgrade-1.4.0` 且包含正在进行的 UI 修改；原地增量实现，不新建遗漏这些修改的 HEAD worktree，不改动或提交其他工作。
- Task 1: complete — `tests/mcp-store.test.ts` 12 项先失败后全部通过，`pnpm typecheck` 通过。新增协议、加密数据库表及配置 store；HTTP header 大小写去重、Windows env 大小写去重，CAS 在异步路径检查之后执行。
- Task 2: implementation verified — 真实 stdio、Streamable HTTP、SSE 握手/分页/调用通过；取消、超时、重复 cursor、目录通知、401 脱敏、挂起握手限时通过；双项目 cwd/roots/进程隔离、并发连接复用、禁用/删除/版本撤销、握手中失效及单 waiter 取消通过。27 项配置/连接/服务测试通过，typecheck 通过。仍需补充重复工具名称和断线恢复等验收案例。
- Task 2: Ruling: fixture 放在 packages/extensions/test-fixtures — 从该包解析锁定 SDK，避免根测试包新增仅用于解析的依赖。
- Task 2: 修复真实失败：SDK initialize 失败会先 close，原认证错误不能被 closed 竞态覆盖；SDK 无 await 的 close 与自身清理共用 transport close promise，确保返回前子进程实际退出。
- Task 3: implementation in progress — OAuth state/PKCE、加密 token、真实回调、过期刷新、退出、URL 变更拒绝旧 provider 两项测试通过；管理 RPC/renderer allowlist/JSON 导入预览三项测试通过，runtime 生命周期已接线。尚需统一验证及界面登录流程验收。
- Task 3: Ruling: JSON 导入解析放在 extensions/mcp-import.ts — daemon 不新增 zod 依赖，公开 schema 仍归 protocol。
- 环境修复：安装 SDK 后两个 pi 依赖 junction 指向旧 peer hash，pnpm install --frozen-lockfile 重建 3 个链接后 typecheck 恢复；未修改这些依赖版本。
- Task 6 管理页已实现：插件中心分 MCP/本地插件页签；配置编辑、secret 保留/替换/清除、项目绑定、启停、连接、目录搜索、导入预览、OAuth 入口、删除确认。McpView 4 项组件/表单测试通过，desktop build 通过；真实本地 RPC 预览环境实测启用→连接→4 工具目录→搜索/详情→编辑保存撤销连接→凭据不回显→JSON 预览/保存保持停用。使用 native dialog 提供焦点隔离与 Esc 关闭。任务能力可见性及 OAuth 浏览器完整 UI 验收仍待做。
- Task 6: Ruling: 管理页面在任务引擎前实现可独立验证的部分 — 管理 RPC 已就绪，用户刚询问页面进度；未因此缩减任务调用/技能协同的交付范围。
- 2026-09-24 Task 4 已接入 engine.execute 的运行 overlay：命名空间、冻结 revision/contract hash、外部只读仍走审批、明确拒绝零执行、运行租约释放、目录超过 48 个或 80 KB 时 search/call 分派、完整 JSON Schema 参数校验、二进制加密附件、未知写入指纹禁止重复。8 项真实运行测试通过；同轮 loop-control/workflow-engine/skill-session 共 44 项通过，typecheck 通过。尚未完成委派工作树授权继承、调度/恢复全矩阵、运行关闭与能力 UI。
- Task 4: Ruling: 大目录使用 mcp_search + mcp_call，dispatch 在 engine 的原授权/执行门前解析成实际定义 — 不动态修改 pi 工具注册，不绕过真实风险、输入校验或审批。
- Task 4: 新增精确锁定 ajv 8.20.0 / ajv-formats 3.0.1（已有锁文件版本）；支持普通 schema 与显式 2020-12，不加载远程 schema、不自动转换参数。
- Task 5 已实现可信 catalog、search_skills/load_skill/read_skill_resource、正文 hash 冻结及 pinned context。真实可控模型→项目技能→实际 MCP→结果进入回答的集成通过；未信任/内容变更/越界资源拒绝。与原 skill-selection/skill-session 一起 9 项通过。尚待同名目录/取消/压缩恢复/缺失依赖的补充验收。
