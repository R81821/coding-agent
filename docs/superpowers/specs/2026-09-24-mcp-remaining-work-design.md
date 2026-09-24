# MCP 剩余工作设计：委派继承、能力可见性、完整验收

日期：2026-09-24
状态：设计已确认，待实现。
上游文档：`docs/superpowers/specs/2026-09-21-mcp-task-skill-design.md`、`docs/superpowers/plans/2026-09-23-mcp-task-skill.md`
基线：分支 `codex/upgrade-1.4.0`，HEAD `65ec093`，工作区含大量未提交修改。

## 背景与范围

2026-09-24 检查确认，MCP 模块完成度高于计划文档记录：44 项 MCP 测试全部通过（store 12、client 9、service 6、oauth 2、rpc 3、runtime 9、skill-integration 3）。协议、加密存储、密钥脱敏、三种真实传输、连接池隔离、OAuth、运行租约、审批门、大目录降级、可信技能链、桌面管理页均已实现并通过实测。

本次范围是**补齐原计划全部剩余项**，包含两部分：

1. 检查中新发现的确认缺陷（计划文档未记录）
2. 计划执行记录中自认未完成的验收项（Task 2/3/4/5/6 遗留）与 Task 7 完整验收

不重做已完成且已验证的部分。

## 已确认缺陷

### 缺陷 1：委派子任务的 MCP 能力继承缺失

`packages/core/src/runtime.ts:135-146` 构造子任务 `RunSpec` 时未传 `mcpSnapshot`，也未设 `mcpReadOnly`。子任务经 `engine.start → execute → prepareMcpCapabilities` 时 `prior` 为 `undefined`，于是**重新解析出完整目录**。

后果：

- 子任务看到的工具目录可能超出父任务已批准的范围
- 只读子任务（`task.mode === "read"`）仍会拿到 MCP **写**工具。原因：`engine.ts:565` 的 `runtimeTools.set` 只遍历 `capabilities.tools`，不经过 `childProfile.toolNames` 过滤

违反设计文档要求："子任务只能继承父任务已允许的能力，只读子任务不得获得写工具"。

### 缺陷 2：`mcpReadOnly` 是死代码，且 analysis/plan 模式未接线

全仓库仅两处出现：`packages/protocol/src/index.ts:449` 定义、`packages/core/src/mcp-capabilities.ts:64` 检查。**没有任何地方设置它**，该分支从未生效。

由此有两个独立触发场景都未覆盖：

- 委派只读子任务（见缺陷 1）
- analysis/plan 模式运行 —— 设计文档明确要求"analysis/plan 限制同样适用于 MCP"

### 缺陷 3：只读过滤会误报为目录变化

`packages/core/src/mcp-capabilities.ts:116`：

```ts
if (prior && prior.length !== snapshot.length) throw new Error("MCP tool catalog changed since this run started");
```

一旦 `mcpReadOnly` 真正生效（或 inherited 取交集），工具数会合法减少，这一行会误报。必须在接线 `mcpReadOnly` 的同时修复，否则缺陷 1、2 的修复会引入新的假失败。

### 缺陷 4：任务能力不可见

- `ToolCallSchema` 只有 `{ id, name, input }`，桌面端拿到的只有命名空间化名称（如 `mcp_a1b2c3d4e5_read_file_f6g7h8i9j0`），无来源信息
- `ToolDefinition.external`（serverId/serverName/toolName/revision/contractHash）已在 `mcp-capabilities.ts:72` 填充，但从未渲染
- `capabilities.diagnostics` 只注入模型上下文（`engine.ts:492`），页面上看不到
- `packages/core/src/run-review.ts` 无任何 MCP 引用

违反设计文档要求："对话工具记录显示原名与服务来源、耗时和证据；任务入口显示实际启用的 MCP 和技能及失败诊断"。

### 观察项（本次不修改）

`engine.ts:565` 把 profile 工具、技能工具、MCP 工具合入 `runtimeTools` 时无名称冲突交叉检查。经核对**实际不可利用**：`mcpToolName` 强制 `mcp_<hash>_<slug>_<hash>` 前缀，撞不上 `search_skills`/`load_skill`/`read_skill_resource`；唯一理论窗口是大目录降级名 `mcp_search`/`mcp_call` 与某个用户自定义工具同名。用户决定本次不修改。

## 设计 A：委派能力继承机制

### 入参职责分离

`prepareMcpCapabilities` 新增独立入参 `options.inherited?: McpToolSnapshot[]`，与既有 `prior`（= `spec.mcpSnapshot`）职责分离：

| 入参 | 语义 | 对服务集 | 对工具集 | 不一致时 |
| --- | --- | --- | --- | --- |
| `prior` = `spec.mcpSnapshot` | 本运行**恢复冻结** | 只保留快照内 serverId，revision 必须相同 | 只保留快照内工具，contractHash/risk 必须相同 | **抛错**（拒绝恢复） |
| `inherited` = `options.inherited` | 父任务**能力上限**（委派） | 只保留 inherited 内 serverId，revision 必须与当前 store 一致 | 取交集，父任务没有的工具不出现 | **丢弃该服务 + 记 diagnostics**（收窄，不静默） |
| `spec.mcpReadOnly` | 只读委派子任务 | 不约束 | 过滤 `risk !== "read"` | 收窄，不记 diagnostics |

**优先级与生效规则：**

- `prior` 存在时忽略 `inherited`。恢复路径上 `prior` 已是更严格的冻结集；且子任务首次解析时 engine 已把它落库（`engine.ts:445`），二者不会冲突。
- `prior` 为 `undefined` 时（子任务首次解析），`inherited` 生效，按上表静默收窄。
- **长度校验仅在 `prior` 存在时运行**（见下），因此 `inherited` 收窄不触发"目录变化"报错——这是刻意的：inherited 路径靠丢弃+诊断表达，不靠抛错。

### 只读运行的判定：仅由委派子任务触发

`mcp-capabilities.ts:64` 的过滤条件（当前为死的 `spec.mcpReadOnly`）接上真实来源：

```ts
const readOnly = spec.mcpReadOnly === true;
```

**唯一设置点**是 `runtime.ts` 为**只读委派子任务**设置 `spec.mcpReadOnly = task.mode === "read"`。必须在 spec 上，否则恢复的只读子任务会重新获得写工具。

**analysis 模式不硬过滤 MCP 写工具（2026-09-24 决定）。** 理由：

- 设计文档原文是"analysis/plan 限制同样适用于 MCP；**write/high/destructive 通过现有审批和运行政策处理**"。所有 MCP 工具已经 `requiresApproval: true`（`mcp-capabilities.ts:71`），审批门已满足该要求。
- `engine.ts:555` 的 probe 在 analysis 模式下**仍然执行**，只是放入只读 Docker 隔离环境。analysis 的语义是"隔离地写"，不是"禁止写"；硬过滤 MCP 会与之一致性冲突。
- 硬过滤会使 `tests/mcp-runtime.test.ts` 的 fixture（`taskMode: "analysis"`）丢失 3 个 high 工具，`snapshot` 从 8 变 2，第 27、46 两批断言失败——而第 46 项还会因目录不足 48 而不再触发 `mcp_search`/`mcp_call` 降级。改测试等于改变已验证的分析模式行为。

**已知限制（接受）：** analysis 模式运行仍会在目录中看到 MCP 写工具，逐个走审批。这与本地工具在同模式下的行为一致。

### 已裁决：`inherited` 中被禁用/解绑的服务静默丢弃不属缺陷

实现阶段提出：父任务快照里的服务若已被禁用或解除项目绑定，会在 `server.enabled` / `projectPaths` 过滤处（循环之前）被排除，**没有诊断**。

2026-09-24 独立审查裁决为**不是缺陷**，不予修复。理由：上表的"不一致"一格受该行自身约束限定——"revision 必须与当前 store 一致"，文档的动机场景明确是"某个无关 MCP 服务被更新"（revision 变化）。同一张表在别处也接受静默收窄：工具交集"父任务没有的工具不出现"（无诊断）、只读行"收窄，**不记** diagnostics"。验收标准只要求为"无关服务 revision 变化"记诊断。且 `enabled`/`projectPaths` 是所有运行（含全新父运行）共用的既有门槛，被禁用的服务是合法的存储状态，不是"自父任务以来发生的变更"。

若将来要求最大化的"不静默"覆盖，这是一个**设计文档修订**事项，不是实现缺陷。

### 为什么 inherited 不一致时丢弃而非抛错

父任务运行期间某个**无关** MCP 服务被更新，不应让整个子任务失败。丢弃是纯收窄，不会放宽权限，因此符合设计文档"不得静默改用不同服务、schema 或更宽权限"——收窄被允许，记 diagnostics 使其不静默。

`prior` 路径保持抛错：恢复必须严格一致。

### 连带的长度校验修复

```ts
// 只读过滤是主动收窄，不计入"目录变化"
const eligible = prior?.filter(tool => !readOnly || tool.risk === "read");
if (eligible && eligible.length !== snapshot.length) throw new Error("MCP tool catalog changed since this run started");
```

### 接线点

| 文件 | 改动 |
| --- | --- |
| `packages/protocol/src/index.ts` | `RunSpec` 新增可选 `mcpInherited?: McpToolSnapshot[]`（与 `mcpSnapshot` 并列） |
| `packages/core/src/mcp-capabilities.ts` | 新增 inherited 过滤分支；修复 line 116 长度校验 |
| `packages/core/src/engine.ts:444` | 传 `options.inherited = spec.mcpInherited` |
| `packages/core/src/runtime.ts:135-146` | 子 RunSpec 设 `mcpReadOnly: task.mode === "read"`、`mcpInherited: parentRun.mcpSnapshot` |

只读判定不收窄 `engine.ts:444` 的调用点，而是在 `mcp-capabilities.ts` 内部按上节的"有效只读标志"计算。

`parentRun.mcpSnapshot` 可直接取得：`runtime.ts:96` 已有 `database.getRun(context.runId)?.spec`。

**为何放在 `RunSpec` 而非仅作为 engine 参数：** engine 已接收 spec，plumbing 最小。持久化无害——恢复时 `prior` 优先，`mcpInherited` 被忽略。`mcpReadOnly` 则**必须**在 spec 上，否则恢复的只读子任务会重新获得写工具。

## 设计 B：任务能力可见性

### 协议层最小面

origin 只加在 **`tool_started` 一个事件**上，**不动 `ToolCallSchema`，也不加在 `tool_call` 上**：

```ts
export const ToolCallOriginSchema = z.object({
  serverId: z.string(), serverName: z.string(),
  toolName: z.string(), revision: z.number().int().positive(),
});
z.object({ ...eventBase, type: z.literal("tool_started"), call: ToolCallSchema, origin: ToolCallOriginSchema.optional() }),
```

**两个理由：**

1. `ToolCallSchema` 同时用于 `RunCheckpointSchema:247` 的 `pendingNonIdempotentToolCalls`（持久化进检查点）与 `packages/providers/src/types.ts:13`。加字段会污染检查点与 provider 类型，并可能影响基于 `ToolCall` 的哈希/比较。origin 只服务 UI，放事件上即可。
2. **`tool_call` 上加不了**：它在 `engine.ts:854-856` 由 provider 流事件发射，早于 `beforeToolCall` 里的 `capabilities.resolve(call)`（`engine.ts:659-662`），那时还不知道是不是 MCP 工具。而 `tool_started` 在 `executeTool` 中发射（`engine.ts:690-691`），`resolve` 已经跑过。桌面端也只消费 `tool_started`/`tool_finished` 构建时间线，不消费 `tool_call`。

### 新增事件

```ts
z.object({ ...eventBase, type: z.literal("capabilities_resolved"),
  mcp: z.array(McpToolSnapshotSchema),
  diagnostics: z.array(z.object({ serverId: z.string(), name: z.string(), error: z.string() })),
  skills: z.array(z.object({ key: z.string(), name: z.string() })) })
```

在 `engine.execute` 中 `prepareMcpCapabilities`（`engine.ts:444`）与 `createSkillRuntime`（`engine.ts:477`）之后发出**一次**。

**"一次"的语义是每次运行一次，不是每次 `execute` 一次。** `resume → launch → execute` 会重跑 `execute`，若不加守卫会对同一次运行重复发射，且内容完全相同（恢复路径下 `prior` 分支失败即抛错、不产生新诊断；技能取冻结的 `spec.skills`），导致续跑后对话里多出一行重复摘要。因此发射需要 `!recovery` 守卫。2026-09-24 质量审查发现并裁定。

**不**在渲染层去重——那会让界面承担引擎的职责。

选事件而非新增 RPC：它天然进入现有会话流，且可被 `mcp-runtime.test.ts` 直接断言。

### engine 填充 origin

`engine.ts:659-662` 已算出 `external = capabilities?.resolve(call)`，其返回值 `tool.external` 即 origin 来源。发射 `tool_started`/`tool_call` 时带上即可，**不改派发逻辑、不改审批路径**。

### 桌面渲染

| 文件 | 改动 |
| --- | --- |
| `conversation-stream.ts` | `ToolTimelineItem` 已存整个 event，origin 自动可用；仅需透传 |
| `tool-summary.ts` | 新增 origin 感知分支：label 显示 `服务名 · 原名`，替代当前原始命名空间串 |
| `ConversationProcess.tsx` | 工具项显示来源徽标 + 耗时（`tool_finished.durationMs` 已有）；附件引用展示 |
| 运行头部 | 订阅 `capabilities_resolved`，展示本次启用的 MCP 服务、技能、失败诊断 |

**"缺失依赖工具提示"无需新协议**：`skill-runtime.ts:47` 的 `load_skill` 返回值已含 `missingTools`，UI 展示该字段即可。

## 设计 C：遗留验收与完整验收

### B 组：三个任务遗留的补测

均遵循"先写失败用例，再实现/确认"。

| 来源 | 补测内容 |
| --- | --- |
| Task 2 | 两个服务提供**同名工具**时的命名空间隔离；服务断开后的重连行为 |
| Task 3 + 6 | **OAuth 浏览器完整往返**——扩展 `apps/desktop/test-fixtures/mcp-preview.ts`，起真实本地 OAuth 服务，走 start → authorizationUrl → 回调 → authorized → 401 刷新 → logout 失效 |
| Task 5 | 同名全局/项目技能目录；取消；压缩后技能规则保留；`missingTools` 提示 |

### C 组：Task 7 完整验收

1. 四种传输真实连接。stdio / Streamable HTTP / SSE 已被 `mcp-client.test.ts` 9 项覆盖；补 OAuth 真实往返
2. **A/B 双项目技能驱动端到端**：服务收到正确 roots 与参数，未授权项目与子任务**零调用**
3. 定时执行与恢复结果一致
4. 多媒体证据、大目录按需加载、未知写不重试、禁用后连接清理
5. `pnpm typecheck` → `pnpm exec vitest run`（全量）→ `pnpm build`
6. `docs/mcp.md` 接入指南：命令/参数/环境变量示例、HTTP token 与 OAuth 配置、项目绑定、技能示例与诊断方式；示例无真实凭据
7. 独立审查，逐条对照 spec 存证

### 贯穿约束

- 原地增量实现，不从 HEAD 新建基线
- 每步先用有实际行为断言的测试复现缺失，再实现
- 不重写现有 UI、评审或预算功能

## 提交策略

**用户指令（2026-09-24，对原计划 Ruling 的显式变更）：完成后提交全部更改。**

原计划 Ruling 为"不把其他工作区修改纳入提交"。本次改为：全部工作完成并通过验证后，提交工作区**全部**更改，含进行中的 UI 修改（`ConversationProcess.tsx`、`CodeChanges.tsx`、`ApprovalDialog.tsx`、`themes.css`、`styles.css` 等）。

设计文档本身随该次提交一并提交，不在中途单独提交。

## 验证方式

| 阶段 | 验证 | 通过标准 |
| --- | --- | --- |
| 设计 A | `tests/mcp-runtime.test.ts` 新增用例 | 只读子任务拿不到写工具；子任务工具集 ⊆ 父任务；父任务快照外的服务不出现；无关服务 revision 变化降级为 diagnostics 且不抛错；只读收窄不再误报"目录变化"；恢复的只读子任务不重获写工具；**既有 44 项 MCP 测试零回归** |
| 设计 B | `tool-summary.test.ts`、`conversation-stream.test.ts`、`mcp-runtime.test.ts` | origin 渲染正确；`capabilities_resolved` 发射且内容与 `capabilities.snapshot`/`diagnostics` 一致 |
| 设计 C | 上述补测 + 全量回归 | 新增用例先失败后通过；44 项既有 MCP 测试无回归 |
| 整体 | `pnpm typecheck`、`pnpm exec vitest run`、`pnpm build` | 全部通过，读取所有失败详情 |

不把"页面存在"或"单独连接成功"当作完成证据。完成声明必须附实际运行结果。

## 交付顺序

三块设计有依赖关系，实现计划按此分阶段，每阶段独立验证后再进下一阶段：

1. **设计 A** —— 纯核心层缺陷修复（protocol / mcp-capabilities / engine / runtime）。设计 B 的 `capabilities_resolved` 需要 A 定稿后的 `snapshot`/`diagnostics` 形状，因此 A 先行。
2. **设计 B** —— 协议事件 + engine 发射 + 桌面渲染。依赖 A 的完成态。
3. **设计 C** —— 遗留补测、A/B 双项目端到端、`docs/mcp.md`、全量回归与独立审查。依赖 A、B 都已落地。

不在 A、B 完成前开始 C 的端到端验收，否则验收对象还在变。

## 审阅要点

1. 设计 A 的"inherited 不一致时丢弃+诊断"取舍是否接受（已确认）
2. 设计 A 把 `mcpInherited` 放 `RunSpec` 是否可接受（已确认）
3. 设计 B 新增 `capabilities_resolved` 事件是否可接受（已确认）
4. 提交全部更改（含进行中 UI 修改）是否确认（已确认）
5. **analysis 模式不硬过滤 MCP 写工具**，只修委派只读；既有 44 项 MCP 测试零回归（已确认，2026-09-24）
6. **origin 只加在 `tool_started`**，不加在 `tool_call` 也不加在 `ToolCallSchema` 上（写计划时发现的技术约束）
