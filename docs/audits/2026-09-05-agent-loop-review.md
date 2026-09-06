# Agent Loop 对照检查

后续状态：本文记录 1.2.0 的审计结果。1.2.1 已修复其中的错误反馈、终端失败分类、修复轮数和最终文本问题，并补充探索收敛控制；见 [1.2.1 发布说明](D:/qweai/docs/releases/1.2.1.md)。原始复现源码仅用于对照旧版本，当前正确行为由 tests/loop-convergence.test.ts 验证。

检查日期：2026-09-05。对象：D:/qweai 当前源码和本地安装的 pi-agent-core 0.84.1。

以用户提供的 16 项工程设计为目标，检查实际代码路径与行为。本文不验证 Claude Code 的内部实现，也不采用材料中的 benchmark 倍数作为本项目的质量依据。没有修改应用逻辑。

结论：现有实现已经具备运行生命周期、工具权限、流式调用、检查点、预算检查和任务结束后的验证重试；尚未形成围绕代码修改证据的完整工程循环。最先应修复反馈丢失、完成门槛、压缩状态和预算一致性，再补仓库侦察与语义工具。

## 已复现的关键问题

### 1. 工具异常的具体原因在回传模型时丢失

位置：[pi-agent-bridge.ts](D:/qweai/packages/core/src/pi-agent-bridge.ts:536)。

pi-agent-core 将执行异常转换为文本错误，同时设置 `details: {}`。Harness 的 `toHarnessMessages()` 使用 `message.details ?? 文本内容`，因此选择空对象，覆盖真正的错误文本。

复现：工具抛出 `UNIQUE_TOOL_FAILURE auth.ts:94 missing user`；第二轮模型请求只出现 `output: {}`，不含错误内容。这意味着 UI/事件日志即使保留异常原因，模型也可能看不到用于诊断的证据。审批拒绝等采用相同底层错误构造方式的路径也需要检查。

建议：规范化 Observation，明确保留 `isError`、错误分类、消息、相关位置和原始日志引用；没有有用 details 时回退文本。测试应检查下一次 provider 请求确实包含错误证据。

### 2. 终端非零退出码没有进入失败恢复计数

位置：[terminalTool](D:/qweai/packages/tools/src/builtins.ts:115)、[桥接工具结果](D:/qweai/packages/core/src/pi-agent-bridge.ts:161)、[恢复计数](D:/qweai/packages/core/src/engine.ts:426)。

复现：实际运行无副作用命令 `exit 1`，输出的 `exitCode` 为 1，但 pi 的 `tool_execution_end.isError` 为 false。Engine 随之清零连续错误计数。独立验证矩阵会检查 exitCode，但模型主动调用 terminal 的路径没有同样的判定。

建议：按工具语义统一判断失败，保留输出再将失败送入恢复策略；不能简单把所有工具的 exitCode 1 视为异常，例如 rg 无匹配需要单独分类。

### 3. Coding Task 可以没有完成证据就进入 completed

位置：[完成判定](D:/qweai/packages/core/src/engine.ts:529)、[空验证矩阵](D:/qweai/packages/core/src/engine.ts:711)、[默认 Profile](D:/qweai/packages/protocol/src/index.ts:597)。

复现：输入“修复仓库中的登录 bug”，模拟模型只回复完成，不读文件、不修改、不测试。默认空验证矩阵下，因为没有记录副作用，任务状态为 completed。

现有保护并非不存在：产生副作用且没有配置验证时会进入 review；required 验证失败也会阻止 completed。但这些条件无法证明用户需求已经满足。是否有副作用不等于是否完成任务。

建议：按任务类型建立完成条件，关联需求条目、观察证据、当前变更版本上的验证和 diff review。纯解释或只读任务应使用适当的只读验收条件，不应机械要求改文件、跑 build。

### 4. Compaction 未成为持续工作状态，摘要费用也漏计

位置：[context transformer](D:/qweai/packages/core/src/pi-agent-bridge.ts:575)、[transcript 回写](D:/qweai/packages/core/src/pi-agent-bridge.ts:126)、[摘要请求](D:/qweai/packages/core/src/pi-agent-bridge.ts:620)。

复现：恢复一段超阈值历史，连续运行两个模型回合；摘要请求发生两次，返回的最终 transcript 仍包含最早的原始历史标记。摘要 provider 发出 usage 后，主 `onProviderEvent` 收到的 usage 次数为零。

原因：transformContext 只改变发送给模型的消息视图，没有替换 Agent 持有的历史；Engine 在 onCompaction 中暂存的压缩 transcript 又被回合事件产生的完整 transcript 覆盖。摘要请求则只处理 text_delta。

另有源码确认的预算边界：

- 估算只包含消息数组，没有合并 system prompt、tool schemas、图像成本及完整输出预留。
- 消息条数较少时即使超阈值也直接返回，单个巨大工具结果可以绕过压缩。
- 按消息条数切片并不保证 tool call/result 成对保留。
- 有 pinned context 时，超限裁剪从索引 2 删除，首先可能删掉新生成的摘要；达到 5 条后即停止，不保证已低于预算。
- 当前摘要是自由文本，并未用 schema 强制保留目标、约束、假设、变更、测试和未决事项。

建议：分离完整审计历史与有界模型工作集；结构化 WorkingMemory 持久化后，后续请求从该状态构建；统一计算和计费所有模型请求；压缩按完整交互块进行，任何裁剪都必须保留当前任务和必要证据。

### 5. 验证修复可越过轮数上限，最终答案串接所有旧结论

位置：[轮数判断](D:/qweai/packages/core/src/engine.ts:397)、[修复循环](D:/qweai/packages/core/src/engine.ts:495)、[文本累加](D:/qweai/packages/core/src/engine.ts:471)。

复现：maxTurns=1，验证始终失败，maxRepairAttempts=2，模型每次只回复文本。实际模型调用 3 次，验证调用 3 次，最终文本为 `claimed done 1claimed done 2claimed done 3`，状态 review。

原因：轮数停止依赖本轮存在 toolResults；修复循环没有在每次重新启动 Agent 前检查轮数额度。verify() 直接执行 terminal，不经过 authorizeTool 的工具计数；总时长限制也是离散检查，并非任务级截止信号。

建议：所有正常、修复、摘要调用共享预算入口；每次模型请求前检查额度，执行阶段受总截止时间约束。最终答案使用最后一个有效完成回合，过程文本保留在独立事件流中。

## 16 项逐项对照

| 项目 | 当前程度 | 实际实现与缺口 |
|---|---|---|
| 1. RECON → HYPOTHESIS → EDIT | 提示词引导 | [安全提示词](D:/qweai/packages/core/src/security.ts:53)要求先检查、失败后解释假设；[authorizeTool](D:/qweai/packages/core/src/engine.ts:569)只检查预算、计划审批和工具权限，不检查是否已有仓库证据。首次调用可直接提出 patch。 |
| 2. Repository Map | 基础检索 | [工具注册](D:/qweai/packages/tools/src/index.ts:13)提供 list_files/search_text/read_file；没有仓库符号索引、相关度筛选和代码范围映射。当前也没有自动读取整个仓库，不能归类为“全仓塞入上下文”。 |
| 3. 语义工具 | 部分实现 | 已有 patch、diff、文本检索；缺 read_range、search_symbol、find_definition/find_references，以及带结构化结果的 run_test/typecheck 等。terminal 能手工运行这些命令，但运行时不理解其任务语义。 |
| 4. 最小 Patch | 部分实现 | [apply_patch](D:/qweai/packages/tools/src/builtins.ts:75)使用 git apply --check 再应用 diff；已优于整文件覆盖。没有修改范围策略和自动 post-edit diff review，terminal 仍可执行整文件重写。 |
| 5. Edit → Verify 闭环 | 任务结束时实现 | [afterAgentRun](D:/qweai/packages/core/src/engine.ts:495)运行配置的命令并将失败交回同一 Agent；不是每次编辑后的验证调度，没有按变更关联测试或从局部扩展到全量的规则。默认矩阵为空。 |
| 6. 日志处理 | 截断，缺诊断提取 | [runProcess](D:/qweai/packages/tools/src/process.ts:16)对 stdout/stderr 分别保留至 1,000,000 字节；[verify](D:/qweai/packages/core/src/engine.ts:746)截取合并输出前 64,000 字符。没有失败测试、错误栈、相关行提取，尾部诊断可能丢失。 |
| 7. Hypothesis | 提示词引导 | [ActiveRun](D:/qweai/packages/core/src/engine.ts:105)没有 hypotheses/evidence/confidence 等字段。现有 [Plan](D:/qweai/packages/core/src/engine.ts:58)由工具请求合成，主要表示授权范围，不是诊断假设或可验证实施计划。 |
| 8. Working Memory | 有历史，无任务工作集 | [context.ts](D:/qweai/packages/core/src/context.ts:14)拼接规则、技能、长期记忆和请求；pinned context 只有已批准计划与权限。没有持续更新的相关文件、符号、当前假设和未决错误清单。 |
| 9. 结构化 Compaction | 有实现但不完整 | 有阈值、近期历史、摘要模型和确定性回退；缺 schema 保证，并存在上述状态、预算和裁剪问题。 |
| 10. 按风险触发 Critic | 未接入主循环 | 存在 review 状态和子任务工具，不等于已经执行代码审查。未见按文件数、API/schema、安全敏感变更触发的 diff reviewer。 |
| 11. 失败升级策略 | 有重试上限 | 有 provider 重试和连续工具异常计数；没有错误指纹、相同动作去重、扩大检索、推翻假设等阶段升级。成功工具会重置全局计数，无法跟踪同一个未解决故障。 |
| 12. 结果驱动状态更新 | 传递原始结果 | 工具回填 transcript，事件保存输出和 usage；缺统一 Observation/Result Processor，无法据结果持续更新需求证据、诊断和验证状态。具体工具异常还可能在桥接中丢失。 |
| 13. Termination Gate | 部分实现 | 有 required verification 与副作用保护，但没有 requirement_satisfied、no_unresolved_failures、diff_reviewed；上述“无工具直接 completed”已复现。 |
| 14. Diff 状态 | 按需工具 | [git_diff](D:/qweai/packages/tools/src/builtins.ts:120)返回 status 和未暂存 tracked diff；没有每次编辑的变更快照、增删行数、patch ledger、初始脏状态基线。暂存区和未跟踪文件内容不在当前 diff 中。 |
| 15. Policy → Sandbox → OS | 审批存在，普通命令隔离未落地 | [Profile](D:/qweai/packages/protocol/src/index.ts:423)有 local/docker/auto 字段，但普通 terminal 路径不读取它，最终[直接 spawn 本机 shell](D:/qweai/packages/tools/src/process.ts:18)。cwd 不限制进程可访问的文件和网络。插件自己的 Docker 执行、Electron renderer sandbox 都不能替代命令 sandbox。 |
| 16. Harness × Model 评估 | 有基础设施，缺真实任务评测 | [eval runner](D:/qweai/packages/evals/src/index.ts:10)默认检查预制事件，live 模式只做 provider 返回文本的连通性检查。尚未形成固定修复任务 × 模型 × Harness 版本的成功率、费用、用时、回归与无关 diff 对比。 |

## 建议实施顺序与验收条件

保留 pi-agent-core 和现有 TypeScript monorepo，在桥接层之上拆清职责即可，无需为了模板重写成 Python，也无需按行数设目标。

1. **先修可靠性缺陷。** 工具错误完整回传；terminal 失败语义归一；修复/摘要预算统一；压缩状态持续生效；最终输出只取有效完成回合。验收：把本文 5 个复现改为正确行为断言，并补大输出、恢复和错误后取消场景。
2. **Context Manager + WorkingMemory。** 使用带版本的任务工作集，保存 objective、constraints、relevant_files、hypotheses、decisions、pending_issues、verification 和 changeVersion。原始输出作为审计 artifact 按需取回；模型输入包含结构化工作集与有界近期交互。验收：多轮压缩与恢复后目标、约束、工具结果关联仍完整；发送预算含规则/工具/输出预留；摘要消耗计入费用。
3. **Verifier + Completion Gate。** 根据编辑范围选择便宜且相关的检查，再按风险扩展；任何新改动使受影响的验证与审查失效。需求检查必须有证据，测试通过不能自动等同需求满足。权限缺失时记录 blocked，不能默认为通过。验收：未执行/已过期/失败的必要检查不会 completed，纯只读任务能使用适当验收条件结束。
4. **Recon + 局部工具 + ChangeTracker。** 先加入 read_range 和 repository_map，再按语言接入符号/引用能力；首个编辑需有相关证据与简要实施假设，可复用用户已提供的证据。每个 patch 后更新相对初始状态的 diff，纳入 staged/untracked 内容与非 Git 降级。验收：仅修改授权且相关的范围，旧用户改动不被归因给 Agent。
5. **Failure Replanning + 条件审查。** 按错误签名跟踪“局部修复 → 扩大检索 → 更新假设 → 深入诊断”，解决证据决定是否清除故障；风险较高时对当前 diff 做 review。验收：重复失败不能被无关 read 成功清零，review findings 能回到同一任务的待办和验证流程。

普通命令 sandbox 是独立的基础设施缺口。如果对外提供 docker/受限网络模式，应在开放该模式前接入真实执行器；不能用新增提示词代替执行隔离。

## 验证记录与复现方法

- 现有相关测试：6 个文件，17 项通过。覆盖 engine、engine-budget、engine-grant、compaction、security、permissions-grant。
- 本次新增审计观察用例：5 项通过。这些断言刻意确认当前缺陷，因此“通过”表示成功复现，不表示缺陷已修复。
- 复现使用本地 fake provider，不调用真实模型。除实际 `exit 1` 外，验证命令均为 fake tool；没有执行项目修改或真实外部命令。
- 应用源码未修改。临时测试已移出 tests，保留为 [复现源码](D:/qweai/docs/audits/agent-loop-audit.repro.ts)，避免把缺陷行为固化为默认回归要求。

在 D:/qweai 下重新运行复现：

```powershell
# 如果该临时目标已存在，应先检查而不是覆盖。
if (Test-Path -LiteralPath 'tests/agent-loop-audit.tmp.test.ts') { throw 'Temporary test already exists' }
Copy-Item -LiteralPath 'docs/audits/agent-loop-audit.repro.ts' -Destination 'tests/agent-loop-audit.tmp.test.ts'
try {
    node node_modules/vitest/vitest.mjs run tests/agent-loop-audit.tmp.test.ts
} finally {
    Remove-Item -LiteralPath 'tests/agent-loop-audit.tmp.test.ts'
}
```

工作目录当前没有可用 Git 元数据（git status 报 not a git repository），因此本次以文件与测试行为为依据，不能给出相对某个 commit 的审查结果。
