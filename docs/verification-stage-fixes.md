# 验证阶段失败率治理方案

起草于 2026-10-10。基于当前工作区（1.4.5）的代码，非旧构建。

## 目标

降低"验证阶段"的失败与误报，**不削弱运行时托管的验证能力**。

用户观察到"很多错误都发生在验证、测试阶段"。分析后拆成三类，处置方式完全不同：

| 类别 | 性质 | 处置 |
|---|---|---|
| A. 准入规则拒绝（`verification_not_planned`、`verification_file_required`、`Planned verification evidence is missing`） | 机制**在正常工作**，但反馈是死胡同 | **修反馈**（本方案 P0） |
| B. 机制自身缺陷 | 真正的 bug | 已修/待修（60 秒评审超时已被移除） |
| C. 过度设计 | 复用层的假通过风险 | **先测量再决策**（P2） |

## 事实基础

已移除（本次核实）：

- **独立模型评审已关闭**。`packages/core/src/coding-workflow.ts:205` 的 `requiresIndependentReview` 恒为 `false`；`:66` 将状态置为 `skipped`，理由为"独立模型评审已关闭；由实际测试、当前 diff 和逐项需求证据完成验收"；`recordIndependentReview` 改为"被调用即抛错"。
- 评审的 60 秒墙钟超时（原 `engine.ts` `AbortSignal.timeout(...)`）已从 `engine.ts` 消失。
- `packages/core/src/independent-review.ts`（73 行）、`packages/core/src/review-evidence.ts`（116 行）在生产代码中**零引用**。

现存的三条准入规则：

1. **只能跑落盘的测试文件** —— `packages/core/src/file-verification.ts:2` 的 `assertFileBasedVerification`，拒绝 `python -c` / `node -e` / `bash -c` / `powershell -Command` / `php -r` / `ruby -e` 及任何非空 stdin。强制点：`engine.ts:727`（工具入口）、`engine.ts:1658`（运行时自身的检查项）。
2. **命令必须与计划逐字匹配** —— `engine.ts:741`，比较 `stage`、`command`、`cwd`、`stdin` 四项全等。
3. **计划证据必须齐备** —— `sequential-workflow.ts:410-413`，若本阶段的计划检查未在结果中逐项命中（按 `itemId` + `command` + `cwd`），**即使命令执行通过，也把 `run.passed` 降级为 `false`**，`skipReason = "Planned verification evidence is missing."`。

> 注意：`.cache/secret-audit/current/` 下有一份**旧源码快照**，其中 `engine.ts:966` 仍在调用 `reviewChanges`。它不是活代码，检索时需排除。

## P0 —— 让失败自带期望值（最高性价比）

### P0-1 `verification_not_planned` 回传期望命令

**问题**：`engine.ts:741-744` 的返回只告诉模型"不匹配，请用精确命令"，但**不列出期望值**。模型跨多轮后无法准确回忆计划的 command/cwd/stdin，只能猜，猜错再吃一次同样的错。

**改动**：在 error 载荷里附带本阶段（`value.stage`）的期望检查清单与不匹配的字段：

```
const expected = workflow.plannedChecks().filter(check => check.stage === value.stage)
  .map(check => ({ command: check.command, cwd: check.cwd, hasStdin: check.stdin !== undefined }));
// 返回：{ code: "verification_not_planned", error: "...", expected, mismatch: ["cwd"|"command"|"stdin"|"stage"] }
```

`expected` 需设上限（例如最多 8 条、command 截断 300 字符），避免把大计划整个灌进上下文。

**验收**：新增测试构造一次不匹配的 `run_verification` 调用，断言返回的 `expected` 含计划的精确命令且 `mismatch` 指出字段。`tests/sequential-engine.test.ts`、`tests/sequential-workflow.test.ts` 保持绿。

### P0-2 "计划证据缺失"列出缺失项

**问题**：`sequential-workflow.ts:410-413` 把一次真实通过的验证降级为失败，理由只有一句英文，**不说是哪一项缺失**。这是最容易被误判为"测试通过却被判失败"的地方。

**改动**：把降级理由从常量字符串改为列出缺失的检查：

```
const missing = expected.filter(check => !run.results.some(result =>
  result.itemId === check.id && result.command === check.command && result.cwd === check.cwd && result.passed));
// skipReason: `Planned verification evidence is missing: ${missing.map(m => m.command).join(" | ")}`
```

同样设数量/长度上限。

**验收**：新增测试构造"命令跑通但计划项未命中"的场景，断言 `skipReason` 含缺失命令；断言 `passed === false` 的行为不变（不要把降级放松掉）。

### P0-3 规范化 `cwd` 比较

**问题**：逐字比较对"等价但写法不同"的 cwd 过于敏感（`validateVerificationInput` 的 `cwd` 默认是 `"."`）。计划里写 `"./src"`、模型传 `"src"` 就会失败，而这与"是否真的验证了"无关。

**改动**：只在比较时规范化，**不放松 `command` 本身**：

- 去尾部斜杠；
- `.\\` / `./` → 统一分隔符；
- Windows 下大小写不敏感；
- 空串与 `"."` 视为等价。

抽成 `sameVerificationCwd(a, b)` 供 `engine.ts:741`、`sequential-workflow.ts:411`、`engine.ts:1672` 三处复用。`stdin` 同理：两侧都为空/未定义视为相等。

**验收**：单元测试覆盖 `./src` vs `src`、`src/` vs `src`、空 vs `.`、Windows 大小写；断言 `command` 不同仍判不匹配。

**风险**：放松比较可能让本应拒绝的调用通过。因此**只规范化路径等价与空白**，命令内容不容忍任何差异。

## P1 —— 把规则前置、清理死代码

### P1-1 "必须落盘测试文件"写进工具描述

**问题**：`file-verification.ts` 的规则目前**只在失败时**才让模型知道。模型反复用内联脚本试探，每次都被拒。

**改动**：把约束写进 `run_verification` 的 `contract.description`（`engine.ts:~722`）。描述里点明：内联解释器脚本与 stdin 不作为验证；断言必须写在测试文件里并经仓库测试入口执行。

**验收**：新增断言工具 `description` 含该约束；`tests/tool-schemas.test.ts` 保持绿。

### P1-2 删除零引用的两个文件

**改动**：删 `packages/core/src/independent-review.ts`、`packages/core/src/review-evidence.ts`——两者在生产代码中零引用，**仅被专项测试引用**，需一并删除：

| 测试文件 | 引用 |
|---|---|
| `tests/audit-review.test.ts` | `import { prepareReviewRequest, reviewChanges } from "../packages/core/src/independent-review.js"` |
| `tests/review-evidence.test.ts` | `import { buildReviewEvidence } from "../packages/core/src/review-evidence.js"` |

删除前先确认这两个测试**没有覆盖仍在使用的能力**（例如费用预算、上下文预算的校验是否已在其他路径重复）。它们当前测的是已不可达的评审函数。

**为什么**：这 189 行仍以"活跃架构"的样子存在，会持续误导读者与 agent（本方案的起草过程就被它误导过一次）。

### P1-3 独立评审残留：分两步，不要一次删干净

**现状**：`WorkflowState.independentReview` 字段仍被读取——

- `coding-workflow.ts:326` `canFinish()` 引用了它（但 `requiresIndependentReview` 恒 false，该分支永不生效）；
- `apps/desktop/src/components/WorkflowProgress.tsx:31` 仍在渲染"历史独立评审：{status}"；
- `run-stop.ts` 的 pending 仍会推入"独立评审"。

**第一步（低风险）**：`canFinish()` 里删掉恒不生效的独立评审分支。已核实：`requiresIndependentReview` 只有两处实现，`coding-workflow.ts:205` 与 `lightweight-workflow.ts:150`，**两者都返回 `false`**，不存在为 true 的路径，因此该分支不可达。

**第二步（需 UI 同步）**：确认界面不再展示"独立只读评审"后再删字段、`rejectIndependentReview`、`resolveSource("independent-review")` 与 pending 项。

## P2 —— 复用层先测量，不直接改

**对象**：`packages/core/src/test-dependencies.ts`（271 行），接入点 `engine.ts:1619`（分析依赖）与 `engine.ts:1672`（`cached` 命中即跳过执行，记录 `reusedFromRunId`）。

**为什么必须先测**：这是全系统唯一一个**错了会静默更自信**的组件——超时是可见失败，复用一个本应作废的通过是不可见失败。

**埋点**：记录每次验证的 `cached` 命中/未命中、命中时的 `reusedFromRunId`、以及复用后同一 run 内是否又出现失败。

**判据**：

- 若一次 run 内"命令相同 + 依赖未变 + 重跑一遍"的占比很低（例如 < 10%），这 271 行买到的只是复杂度，建议移除或改为显式可选（`value.force` 已存在，可反向做成默认不复用）；
- 若占比高，保留，但收紧复用条件并补一条"依赖指纹不完整时一律不复用"的测试。

## 明确不做

- **不动**运行时的命令执行、退出码记录、`codeFingerprint`、工作区变更作废（`compareWorkspace` + `verifiedSnapshot`）。这是系统的差异化价值，且 bug 面很小。
- **不把准入规则降级为警告**。规则本身站得住（不许拿一行内联脚本冒充验证；检查必须对应计划），且模型本来就能从 `projection()` 看到计划命令。先修反馈，再谈放松。

## 冲突与实施顺序

`engine.ts`、`sequential-workflow.ts`、`run-stop.ts`、`protocol/workflow.ts` 正由 codex 并行修改（三个文件当前均为 dirty）。

- 本方案 P0/P1 全部落在这几个文件上，**不要按本文行号直接改**——行号会漂。实施前先 `git status` 并重读目标函数。
- 建议由**同一方**串行实施：要么交给 codex，要么等其停手后再做。
- 死代码删除（P1-2）风险最低，可独立先做。

## 验收总则

- `pnpm typecheck` 与全量 `pnpm exec vitest run --maxWorkers=2` 保持绿（起草时基线：118 文件 / 809 项）。
- 每个变更项配一个可 RED/GREEN 的测试：先还原改动确认测试失败并报出预期信息，再应用改动确认通过。

## 实施记录（2026-10-10）

### P0：已实施

- `verification_not_planned` 返回当前请求阶段的 `expected`、`expectedCount`、`expectedTruncated` 和 `mismatch`。最多 8 项，command/cwd 各最多 300 字符；截断有标识，不返回 stdin 内容。`mismatch` 指向最接近的计划检查中不一致的字段；请求的阶段不存在时包含 `stage`。
- 计划证据缺失列出缺失命令及 cwd，最多 8 项，显示剩余项数量。失败降级保持有效。
- 新增 `verification-matching.ts`，在工具准入、计划证据匹配和保存结果的复用比较中统一目录比较。仅目录写法等价和空/未定义 stdin 等价；命令、实际 stdin 内容仍严格比较。Windows 支持分隔符和大小写等价；Linux 保留大小写与反斜杠语义。不删除路径名中的空白，不折叠可能受符号链接影响的 `..`。
- 修正实施时发现的状态分歧：过去降级只影响工作流内部的克隆，原回执与持久事件仍可能显示通过。现在先完成计划证据判定，再保存/发布同一回执，工具返回、数据库、事件及工作流保持一致；真实单项的退出码、输出和通过状态不改写。过期工作流记录或 checkpoint 保存异常仍不会吞掉终态事件。

### P1：规则前置与第一阶段清理已实施

- 工具描述明确断言必须写入真实测试文件，通过仓库测试入口执行；内联解释器脚本及非空 stdin 被拒绝。
- 删除零生产引用的 `independent-review.ts`、`review-evidence.ts` 及它们的专项测试。仍在使用的 provider 截断 usage/diagnostics 和完整需求上下文边界迁移到 `active-verification-capabilities.test.ts`；现有费用与上下文预算覆盖保留。
- `canFinish()` 直接使用正常完成条件，不再查询已关闭的独立评审准入条件。`run-stop.ts` 当前已无独立评审 pending 项，无需重复修改。
- 按本方案的分阶段约束，**仅实施 P1-3 第一步**。当前 UI 仍支持旧会话的“历史独立评审”，因此保留 `independentReview` 字段与历史读取兼容路径。第二步需要先同步迁移历史显示与存量数据，不能直接删字段。

### P2：测量已接入，缓存算法未改

- 每个实际访问的验证项保存 `verification_cache_decision` 事件，记录 cached、source、force、原因、依赖完整性和适用的 reusedFromRunId。没有访问的暂停项不虚构未命中。
- `source` 区分 `saved_run`、`checkpoint`、`same_suite`、`executed`、`unavailable`。命中/未命中比率只统计 saved run 查找与执行/不可执行项，checkpoint 恢复和同套件去重单列；同时提供剔除 force 的比率。
- `verification-reuse.ts` 从持久事件重放统计。记录同一任务 run 内复用后是否发生验证失败、是否是同一检查项失败；这是关联指标，不证明缓存导致失败。取消单列，真实超时仍算失败。旧日志缺少埋点时返回未知值，不推测未命中。
- `run_verification` 返回有界 `reuseMeasurement` 汇总，来源 ID 最多 8 条并标识截断；完整逐项记录保存在事件里。活跃 run 增量读取事件，恢复运行后可从持久事件重建测量。
- 新增依赖指纹不完整时拒绝复用的 4 项回归测试。完整性、指纹、工作区变更作废、退出码和实际命令执行逻辑保持原有约束。
- 目前已验证真实测试夹具的埋点与重放。还没有代表日常使用的生产样本，**不据此采用 <10% 判据删除或关闭复用**。

### 验证记录

- 测试全部落盘，没有用临时内联断言替代测试文件。
- RED/GREEN 覆盖计划不匹配反馈、路径/空 stdin 别名、缺失证据降级与发布一致性、移除完成时的独立评审分支、真实执行与复用测量。
- 不完整依赖指纹的已有防线原本即通过；没有修改正确的缓存逻辑来人为制造 RED。
- 当前工作区包含本任务前的浏览器截图和任务图修改；全量检查覆盖合并后的实际工作区，不使用旧缓存源码快照。
- 全量 `pnpm exec vitest run --maxWorkers=2`：**147 文件 / 1225 项全部通过**（220.37 秒）；日志 `.test-verification-stage-full.log`。起草时的 118 / 809 为旧基线，本任务前合并工作区已是 143 / 1213；删除死评审测试并补充有效回归后，以本次全量结果为准。
- `pnpm typecheck`、`pnpm lint`、`git diff --check` 通过。RED/GREEN 日志保存在工作区 `.test-verification-*.log`，日志由 `.gitignore` 排除。
- 本次不打包、不生成安装包。
