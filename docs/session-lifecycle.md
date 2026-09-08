# Session 生命周期

Harness 将一次连续对话保存为一个持久化 Session。每条用户消息仍创建独立 run，因此每轮都有自己的预算、审批、检查点、CodingWorkflow 和验证记录；这些 run 复用同一个 `sessionId`，所以用户可以继续追问而不丢失前文。

## 创建与继续

Session 只由两个明确操作创建：

1. 点击侧栏“新建任务”，在当前项目创建并选中一个空白 Session；尚未选择项目时先打开代码仓库。
2. 点击项目行的 `+`，直接在该项目创建并选中一个空白 Session。

发送消息、启动应用、切换 Profile、展开项目或切换历史都不会隐式创建 Session。发送消息需要已有活动 Session；桌面端只生成新的 run ID，并把 run 追加到活动 Session。空白 Session 会立即加密落库，应用重启后仍然存在。首条消息会更新默认的“新会话”标题。

应用启动后尝试恢复上次打开且仍可见的 Session；该 Session 已删除或不存在时，打开最近的可见 Session。侧栏始终按“项目 → Session”显示，打开历史 Session 会按 run 创建时间恢复全部用户消息、Agent 回复、工作流和工具事件。

## 模型上下文

新 run 启动前，daemon 读取同一 Session 中更早的 run。已完成轮次使用用户请求和最终 `result`；未完成轮次带有明确的状态标记。历史按创建时间和 run ID 稳定排序，其他 Session 的内容不会进入当前请求。

历史文本始终标为不可信上下文数据，不能覆盖应用策略、当前 Profile、当前用户请求、项目指令信任、沙箱或权限。上下文超过预算时优先保留最近完整轮次，较早轮次压缩为带标识的摘要。当前消息的图片只附到当前用户消息，不会错误归到旧轮次。

`run.start` 会校验 Session 存在且未删除、项目可见、工作区路径一致，并拒绝同一 Session 同时存在第二个活动 run。远程 Telegram/飞书聊天使用连接器与聊天 ID 组成稳定 Session ID。

## 删除、恢复与永久删除

Session 行和项目行的删除按钮只写入加密数据库中的删除时间：

- 删除 Session 后，它从侧栏消失并进入“设置 → 已删除的会话与项目”。恢复会保留全部 run 和记忆。
- 删除项目后，项目及其 Session 从 Harness 侧栏隐藏。该操作不会读取、移动、修改或删除工作区目录与任何磁盘文件。恢复项目后，未被单独删除的 Session 重新出现；若 Session 本身也已删除，设置页会提示先恢复项目，再恢复 Session。
- 有活动 run 时，daemon 拒绝删除对应 Session 或项目，界面保留当前状态并显示错误。

设置页为已删除 Session 提供“恢复”和“永久删除”，为已删除项目只提供“恢复”。永久删除要求再次确认，并在固定数据库事务中删除该 Session、所属 runs、events、plans、checkpoints、compactions、verification runs、approvals 和 traces。渲染器不能提交表名、SQL 或文件路径。

软删除、恢复和永久删除 Session 都不会调用记忆删除接口，也不会删除或修改 `memories` 与 `memory_search`。因此永久删除聊天/运行历史后，Session 或项目作用域的长期记忆仍可保留。记忆只能通过记忆管理器中的独立操作删除。

## 旧数据迁移

首次打开新版数据库时，Harness 从现有 runs 按 `sessionId` 回填 Session，并按规范化 `workspacePath` 回填项目。旧 run 载荷不重写；旧版每个 run 使用不同 Session ID 时，会自然迁移为多个单轮 Session，历史不会丢失。
