# 持久化 Session 与回收站设计

## 背景与目标

当前桌面端每次发送消息都会生成新的 `sessionId`。数据库以 run 为主要历史记录，侧栏将每个 run 当成一条会话，并根据 `workspacePath` 临时分组。因此连续对话无法稳定共享完整上下文，空白会话无法持久化，项目和会话也没有独立的删除、恢复状态。

本次改造将 Session 提升为一等持久化实体。一次 Session 可以包含多个按顺序执行的 run；每次发送仍创建独立 run，以保留每轮任务的预算、验证、审批和工作流状态，但使用同一个 `sessionId`。只有点击“新建任务”或仓库区域的 `+` 才创建新的 Session。

删除采用软删除。删除项目仅影响 Harness 内的展示状态，绝不修改或删除磁盘上的代码仓库。删除 Session 和项目均可在设置中恢复。只有设置里的“已删除 Session”提供永久删除；永久删除 Session 的运行数据时仍保留记忆。

## 数据模型

新增加密存储的 `sessions` 表，记录：

- `id`：稳定 Session ID。
- `workspacePath`：所属代码仓库路径。
- `profileId`：默认 Profile，新消息可随当前选择更新。
- `title`：首条用户消息生成的标题；空白 Session 显示“新会话”。
- `createdAt`、`updatedAt`：创建时间和最后活动时间。
- `deletedAt`：可选；存在时表示进入回收站。

新增加密存储的 `projects` 表，记录：

- `id`：由规范化 `workspacePath` 生成的稳定标识。
- `workspacePath`：真实仓库路径，仅作为 Harness 的项目引用。
- `createdAt`、`updatedAt`。
- `deletedAt`：可选；存在时项目从侧栏隐藏。

`runs` 表继续保存每轮 Agent 执行。`RunSpec.sessionId` 关联 Session，但不引入数据库外键，以兼容旧数据和当前加密载荷。首次迁移时，从现有 runs 按 `sessionId` 回填 Session，再按 `workspacePath` 回填项目。旧版本每个 run 使用独立 `sessionId`，迁移后自然成为单轮 Session，不丢失历史。

项目删除和 Session 删除彼此独立：

- 项目软删除后，侧栏隐藏整个项目，但不修改其中 Session 的 `deletedAt`。
- 恢复项目后，只显示其中未被单独删除的 Session。
- Session 可在项目已删除时单独恢复；它仍在设置中可见，项目恢复后回到侧栏。

## Session 生命周期

应用解锁后恢复上次打开的、仍可见的 Session。上次 Session 不存在或已删除时，依次选择当前项目最近 Session、全局最近 Session；均不存在时显示空白起始页，但不自动创建 Session。

创建 Session 只有两个入口：

1. 点击“新建任务”：在当前仓库下持久化一个空白 Session，并切换到该 Session。尚未选择仓库时先要求选择仓库。
2. 点击项目区域的 `+`：选择并检查仓库，建立或恢复项目元数据，然后在该仓库创建一个空白 Session。

发送消息时必须已有活动 Session。桌面端为该消息生成新的 run ID，复用活动 Session ID，并将 run 追加到 Session。首条消息更新 Session 标题；后续消息不创建新 Session。运行完成、失败或进入 Review 后，Session 仍保持活动状态，可以继续发送下一条消息。

切换历史 Session 时加载该 Session 下的全部 run 摘要与事件，按创建时间展示多轮用户消息和 Agent 回复。运行中的 Session 只轮询当前活动 run。

## 对话上下文

每个新 run 继续使用独立的 `CodingWorkflow`、预算、验证、审批和检查点，避免上一任务的工作流门槛污染下一条用户请求。

在构造模型初始消息前，运行时读取同一 Session 中当前 run 之前的历史，生成持久化对话上下文：

- 每个历史 run 提供用户请求。
- 使用最终 `result` 事件作为 Agent 回答。
- 对缺少最终结果的中断 run，提供明确的中断标记和有限摘要，不把未确认的工具执行当成已完成事实。
- 历史按时间和 run ID 稳定排序。
- 超出上下文预算时从最旧轮次开始压缩为结构化 Session 摘要，保留最近对话原文、用户约束和未解决事项。

历史内容作为对话数据传入，不能提升为系统指令或绕过当前 Profile、权限、沙箱和项目指令信任边界。当前用户请求、当前工作流状态和当前权限始终拥有更高优先级。

现有 Session 作用域记忆继续以稳定 `sessionId` 召回；项目记忆继续以 `workspacePath` 召回。删除、恢复或永久删除 Session 都不调用记忆删除接口，也不删除 `memories` 或 `memory_search`。因此源 run 被永久删除后，记忆的 `source` 可能指向不存在的 run；界面应将其显示为“来源会话已删除”，而非删除记忆。

## 删除、恢复与永久删除

侧栏项目行和 Session 行都增加删除按钮。按钮点击不得触发父行的展开或切换行为。

删除 Session：

- 有运行中的 run 时先拒绝删除，并提示取消或等待结束。
- 弹出确认，说明可在设置恢复且记忆不受影响。
- 写入 `deletedAt`，立即从侧栏移除。
- 若删除当前 Session，清空当前聊天视图并选择同项目最近的可见 Session；没有则显示起始页。

删除项目：

- 有该项目的运行中 run 时拒绝删除。
- 确认文案明确“只从 Harness 隐藏，不删除磁盘文件和记忆”。
- 写入项目 `deletedAt`，隐藏整个项目及其 Session。
- 若为当前项目，清空活动 Session 和聊天视图，但保留磁盘路径引用供恢复。

设置新增“回收站”区域：

- “已删除 Session”显示标题、仓库、删除时间，提供“恢复”和“永久删除”。
- “已删除项目”显示仓库名、完整路径和删除时间，提供“恢复”。项目不提供永久删除入口，避免让用户误以为会操作磁盘仓库。
- 恢复 Session 不改变其历史 run 和记忆；若项目已删除，Session 保持只在回收站可操作，并提示需同时恢复项目。
- 永久删除 Session 二次确认后，事务性删除 Session 及其 runs、events、plans、checkpoints、compactions、verification runs、approvals 和 traces。附件仅在确认没有其他 run 引用时删除。记忆及其搜索索引不参与事务。
- 永久删除 Session 后不可恢复。

## 协议与服务接口

协议新增以下请求：

- `sessions.create`
- `sessions.list`，支持分页和 `deleted` 过滤
- `session.get`，返回 Session、按顺序排列的 runs 及其事件
- `session.delete`
- `session.restore`
- `session.purge`
- `projects.list`，支持 `deleted` 过滤
- `project.delete`
- `project.restore`

所有改变删除状态和永久删除的请求只允许经过已校验的桌面 IPC 边界。服务端不接受渲染器传入的任意表名、文件路径或 SQL 条件。永久删除按 Session ID 解析关联记录，事务范围由数据库层固定。

`run.start` 验证 Session 存在、未删除、所属项目未删除且 `workspacePath` 一致；随后保存 run 并更新 Session 活动时间。远程连接器继续使用聊天 ID 对应的稳定 Session，首次消息时自动建立 Session 和项目记录。

## 桌面界面

侧栏结构保持“项目 → Session”。项目行新增：

- 创建 Session 的 `+` 按钮。
- 软删除项目的删除按钮。

Session 行显示标题、最后状态和最后活动时间，并增加软删除按钮。运行状态来自该 Session 最近的 run。活动 Session 的聊天区按轮次显示所有用户消息和 Agent 回复；当前运行的实时事件追加到最后一轮。

顶层“新建任务”与项目行 `+` 均立即持久化空白 Session，因此应用重启后仍能看到尚未发送消息的 Session。为避免误创建，普通发送、切换 Profile、切换项目展开状态和应用启动都不得隐式创建 Session。

设置页的回收站默认折叠，分别显示 Session 和项目。恢复后刷新侧栏；永久删除需要二次确认，并明确提示 Session 历史不可恢复、记忆仍保留。

## 并发与失败处理

- 一个 Session 同一时间只允许一个活动 run；服务端校验，避免双击或多个窗口并发启动。
- 软删除、恢复和 Session 永久删除使用数据库事务或单条幂等更新。
- 重复删除已删除实体返回当前状态；重复恢复已恢复实体返回当前状态。
- 永久删除不存在的 Session 返回明确错误，不影响其他 Session。
- 加载某个历史 run 失败时保留当前 Session 视图，与现有历史恢复行为一致。
- 项目路径比较沿用 Windows 不区分大小写、统一斜杠并去除尾部分隔符的规范化规则；展示仍使用最近选择的真实路径。

## 测试与验收

按 TDD 顺序增加以下回归测试，并确认每项在实现前因缺少行为而失败：

1. 连续两次发送产生两个 run，但只产生一个 Session，且 `sessionId` 相同。
2. 第二个 run 的模型输入包含第一个 run 的用户请求和最终回答，不包含其他 Session 的内容。
3. “新建任务”和项目 `+` 各创建新 Session；普通发送和应用启动不创建额外 Session。
4. 重启数据库后空白 Session、多个轮次、标题和活动时间仍存在。
5. 软删除 Session 后默认列表不可见，回收站可见，恢复后历史完整。
6. 永久删除 Session 删除其运行相关数据，但记忆记录和搜索结果保持不变。
7. 软删除项目隐藏其 Session，恢复项目后仅显示未单独删除的 Session，且磁盘目录没有任何写入或删除。
8. 项目回收区只允许恢复，不提供会被误解为删除磁盘仓库的永久删除入口。
9. 有活动 run 时拒绝删除 Session 或项目。
10. IPC 白名单允许新增的固定方法，并继续拒绝未声明的删除方法。
11. 真实构建后的 Electron 冒烟测试覆盖：连续消息复用 Session、两个显式新建入口、行内删除按钮不触发切换、设置恢复、永久删除确认和项目层级显示。
12. 完整单元测试、类型检查、lint、构建和安装包内容检查全部通过后再发布。

## 明确边界

- 项目删除从不删除或移动本地代码仓库。
- Session 删除不删除记忆；永久删除 Session 也不删除记忆。
- 本次不增加云同步、多设备冲突合并、Session 重命名、跨项目移动 Session 或记忆来源重写。
- 每条用户消息仍是独立 run，因此预算、审批和 CodingWorkflow 从当前任务重新开始；共享的是持久化会话历史和 Session 作用域记忆。
