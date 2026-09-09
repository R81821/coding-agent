# Agent Loop 可靠性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复新建文件补丁误拒绝、验证启动过早、修复计数混用及停止原因不明确，让尚有预算的任务能完成必要的诊断、修改与验证。

**Architecture:** 保留现有 CodingWorkflow、模型桥接及运行时验证门槛。新增明确的验证检查点，分离失败恢复计数与正常流程推进；用结构化停止信息连接运行记录和 UI。审批风险分类继续负责授权，不再直接决定验证时机。

**Tech Stack:** TypeScript、Zod、pi-agent-core、React、Vitest、Git、Windows PowerShell 5.1。

**Spec:** 本文“设计约束与验收标准”，落实用户 2026-09-09 指定的四项修复。状态：已实施并通过最终集成验证。

## 已确认的证据

| 运行 | 工具调用 | 模型轮次 | 实际终止条件 |
| --- | --- | --- | --- |
| 2026-09-09，run_ce37d3f7 | 15/64 | 8/24 | 修复次数耗尽，验证仍未完成 |
| 2026-09-08，run_5d0e9477 | 20/64 | 13/24 | 修复次数耗尽，验证仍未完成 |

两次都先执行依赖探测终端命令，运行时立即验证尚未创建的脚本，随后创建脚本的补丁因 `--- /dev/null` 被拒绝。源码最小复现确认普通修改补丁可通过路径预检，新建文件补丁被误判。相关现有 34 项测试通过，缺少对这条组合故障链的覆盖。

## 设计约束与验收标准

- 按用户最新要求，默认 maxToolCalls=128、maxTurns=64；失败修复不设次数上限，使用 null 表示不限。30 分钟及 5 美元预算保持不变。更新内置默认 Profile 及当前使用的 default Profile；其他 Profile 的工具/模型自定义预算保持原值，修复次数统一改为不限。迁移幂等，保留其他配置。历史及正在运行的 RunSpec 预算快照不改，新预算对之后创建的运行生效。
- 保留权限审批、工作区边界、失败诊断、证据版本新鲜度、需求核对与最终评审门槛。
- 不把任意 python -c、PowerShell 或 shell 命令自动降为只读权限。未知命令可继续保守使验证戳失效，但不能仅凭 high 风险就立即运行验证。
- 标准 unified diff 新建和删除文件允许 /dev/null 哨兵；实际文件路径仍必须在工作区内。合法代码内容出现 ../ 不应被全补丁字符串搜索误拒绝。
- 模型通过 update_workflow action=request_verification 请求运行时检查；它不能自报测试通过。模型准备结束时运行时也必须检查完成门槛，不能因未主动请求而绕过验证。
- 一次逻辑修改可包括实现文件、测试和脚本；允许完成这一小批修改再验证。真正到达预算、重复无进展或连续工具错误限制时仍须停止。
- 修复次数只在运行时向模型派发一次失败恢复任务时递增；正常验证、git_diff、需求核对、最终评审及总结不占修复次数。
- 同一恢复任务里的读代码、诊断和补丁调用只记一次恢复；工具自身错误自纠正也不因累计次数停止，maxToolSelfCorrections 使用 null 表示不限。保留重复无进展检测及工具、模型、耗时和费用硬预算，避免另一处固定自纠正上限提前终止。
- 新检查点持久化修复次数。同一个 run 恢复不清零；同一 session 的新 run 独立计数。旧检查点缺少字段时从历史 repair_started 事件恢复次数，存在历史重启段则累计派发事件数。
- 同一 run 的失败修复可持续进行，不使用 maxRepairAttempts 作为终止条件；计数仅用于显示、审计和失败升级策略。每次调用仍受工具 128 次、模型 64 轮及耗时、费用预算约束。
- 停止结果必须包含真实原因、各额度已用/上限、当前阶段、未完成门槛和最近失败摘要；原始工具全文保留在已有日志中。
- 旧会话、旧 result 事件及旧检查点可正常加载。会话、项目和记忆生命周期不改动。

## 任务 1：修复补丁路径预检

**文件：** 修改 packages/tools/src/builtins.ts；新增 packages/tools/src/patch-validation.ts、tests/patch-validation.test.ts。

**接口：** 新增 `validatePatchPaths(patch: string): void`；通过返回 void，拒绝时抛出 Error。applyPatchTool 先调用它，再保留 git apply --check 和 git apply 的实际校验流程。

- [ ] 添加临时 Git 仓库测试，覆盖新建、修改、删除文件的真实 applyPatchTool 执行及文件结果。
- [ ] 添加路径单元测试：只将完整 header 路径 /dev/null 视为哨兵，另一个文件路径必须有效；两侧都为哨兵、/dev/null/child、盘符路径、UNC、正反斜杠父级跳转、rename/copy 越界均拒绝。允许内容行包含 ../。覆盖空格及带引号路径，不能正确解析的 header 明确拒绝。

```ts
import { expect, it } from 'vitest';
import { validatePatchPaths } from '../packages/tools/src/patch-validation.js';
it('accepts a standard new-file sentinel', () => {
  expect(() => validatePatchPaths('--- /dev/null\n+++ b/probe.txt\n@@ -0,0 +1 @@\n+probe\n')).not.toThrow();
});
it('rejects traversal in the actual target', () => {
  expect(() => validatePatchPaths('--- /dev/null\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+probe\n')).toThrow();
});
```

- [ ] 运行 `node node_modules/vitest/vitest.mjs run tests/patch-validation.test.ts --maxWorkers=1`，确认当前问题能够复现。
- [ ] 实现 header 专用解析，检查 ---/+++、diff --git、rename/copy 的实际路径；去除约定 a/、b/ 前缀后按路径段检查。不要采用全字符串 ../ 检测，不使用 git apply --unsafe-paths。权限和 Git 自带链接/路径检查继续保留。
- [ ] 重跑测试，验证误判被修复且越界文件未产生。提交 `fix: validate patch paths without rejecting null sentinels`。

## 任务 2：建立明确的验证检查点

**文件：** 修改 packages/core/src/coding-workflow.ts、packages/core/src/engine.ts、tests/coding-workflow.test.ts、tests/workflow-engine.test.ts、tests/workflow-fixture.ts。

**接口：** update_workflow action 新增 `request_verification`。不带 passed 字段来设置验证状态。请求成功时 engine 设置一次性的 verificationRequested 标记；在当轮工具结果返回后交还运行时，在消费标记时立即清除。

- [ ] 扩展 workflow-engine 的 runScenario 模式，新增 `probe-before-script`、`multi-edit-checkpoint`、`failed-patch-recovery`。Fake provider 先探测，再创建脚本，再请求验证；通过事件序列断言首次验证发生在创建之后。

```ts
it('waits for the probe script before validating the batch', async () => {
  const result = await runScenario('probe-before-script');
  expect(result.result.status).toBe('completed');
  const events = result.events;
  const created = events.findIndex(e => e.type === 'tool_finished' && e.callId === 'create-probe' && !e.isError);
  const verified = events.findIndex(e => e.type === 'verification_started');
  expect(created).toBeGreaterThanOrEqual(0);
  expect(verified).toBeGreaterThan(created);
});
```

- [ ] 运行新增测试，确认现有风险即验证逻辑使顺序断言失败。
- [ ] 移除 engine 在每个非 read 工具开始时设置 yieldForVerification 的逻辑。执行前的权限和保守验证失效规则保留；失败补丁走诊断路径，不能遗留一个让后续每轮立即退出的标记。
- [ ] 在 update_workflow 成功处理 request_verification 后设置检查点标记；失败请求不设置。记录本轮边界后清除标记，再验证或进入诊断，不让它跨恢复调用泄漏。
- [ ] 模型无工具的结束回复也进入运行时完成检查；修改任务须运行必需验证，缺配置仍不能完成。代码要求 requirements/review 时验证未就绪，返回明确请求检查点的工具错误。
- [ ] 更新工具契约及运行时提示：先完成可验证的小批修改，再 request_verification；验证结果由运行时写入，失败先诊断。保持 local → broader 顺序。
- [ ] 添加多工具同轮含检查点的测试：先完成已授权的当轮工具批次再验证；随后出现修改仍使旧验证失效。
- [ ] 运行 workflow-engine、coding-workflow、workflow-audit、loop-convergence 测试。提交 `fix: verify at explicit workflow boundaries`。

## 任务 3：取消修复次数上限并更新运行预算

**文件：** 修改 packages/core/src/engine.ts、packages/core/src/runtime.ts、packages/protocol/src/index.ts、apps/desktop/src/renderer.tsx、tests/workflow-engine.test.ts、tests/engine-budget.test.ts；新增 tests/repair-budget.test.ts。

**接口：** ActiveRun 增加 `repairAttemptsUsed: number`；RunCheckpointSchema 增加可选的同名非负整数字段。新运行设为 0，新检查点总是保存。maxRepairAttempts、maxToolSelfCorrections 使用 nullable 数值兼容旧数据，新默认为 null。repair_started 及 self_correction_started 的 maxAttempts 支持 null；attempt 仍为真实次数。旧整数配置可解析，迁移后不再用于限制修复。

- [ ] 修改 RunBudgetSchema 默认值与 DEFAULT_PROFILE：maxToolCalls=128、maxTurns=64；检查 UI 和构造 RunSpec 的回退值，避免仍硬编码 64/24。
- [ ] 为持久化 Profile 增加一次性、幂等的迁移：default 更新为 128/64；所有 Profile 的修复和工具自纠正限制置为 null，保留验证项、模型路由、权限、费用及其他设置。迁移完成后用户再次修改的预算不应在每次启动被覆盖。
- [ ] Profile 设置将修复限制改为“修复次数不限，受运行总预算约束”，移除 0–5 次选择，避免保存时把 null 回退成 2。修复事件显示“第 N 次修复”，不显示 N/null。
- [ ] 扩展场景 `normal-gates-unlimited-repairs`、`five-failures-then-pass`、`repair-until-tool-budget`、`repair-until-model-budget`、`resume-repair-count`；用假模型验证超过旧 2 次修复、3 次工具自纠正上限仍可继续，直到通过或触发实际总预算。

```ts
it('allows more than two repairs while total budgets remain', async () => {
  const result = await runScenario('five-failures-then-pass');
  expect(result.result.status).toBe('completed');
  expect(result.events.filter(e => e.type === 'repair_started').length).toBeGreaterThan(2);
});
it('records unlimited repair allowance explicitly', async () => {
  const result = await runScenario('five-failures-then-pass');
  for (const event of result.events) {
    if (event.type === 'repair_started') expect(event.maxAttempts).toBeNull();
  }
});
```

- [ ] 先运行测试确认旧 round 上限、工具自纠正上限及协议不满足预期。
- [ ] 将 round 上限循环替换为按状态推进的循环：优先检查实际总预算；可完成则退出；需要验证则验证；存在失败则记录次数并派发恢复；无失败且门槛待完成则普通推进。

```ts
// 只记录派发次数，不再按修复次数提前终止。
if (needsFailureRecovery) {
  state.repairAttemptsUsed += 1;
  // 先保存检查点与 repair_started(maxAttempts: null)，再调用模型。
}
```

- [ ] 每次调用模型仍执行 turns/tools/time/cost 检查；明确 null 表示无计数上限，不能依赖与 null 的隐式数值比较。移除工具连续错误达到固定次数后提前终止的分支；失败升级和重复无进展检测保留。
- [ ] 验证 attempt 使用已派发恢复次数，允许正常重复验证共享 attempt，以唯一 verificationRunId 区分检查。普通验证、需求核对及最终评审不增加恢复次数。
- [ ] 持久化并恢复计数；测试新旧检查点、同 run 恢复和同 session 新 run。恢复后计数不清零，历史预算快照仍按原值执行。
- [ ] 测试工具 128 上限、模型 64 上限、摘要占用剩余预算、时间/费用耗尽；反复失败或自报完成不得越过总预算和完成门槛。提交 `fix: allow unlimited repairs within expanded run budgets`。

## 任务 4：结构化停止原因与 UI 展示

**文件：** 修改 packages/protocol/src/index.ts、packages/core/src/engine.ts、packages/core/src/run-progress.ts、apps/desktop/src/renderer.tsx；新增 packages/core/src/run-stop.ts、apps/desktop/src/components/RunStopCard.tsx、tests/run-stop.test.ts；扩展 tests/renderer-ipc.test.ts。

**接口：** result 事件新增可选 `stop: RunStopInfo`。Zod schema 与 TypeScript 类型保持一致，旧事件不带 stop 时保留原有渲染。

```ts
type RunStopCode =
  | 'model_turn_limit' | 'tool_call_limit'
  | 'cost_limit' | 'duration_limit'
  | 'repeated_observation' | 'verification_config_missing'
  | 'review_incomplete' | 'provider_error';
interface RunStopInfo {
  code: RunStopCode;
  message: string;
  phase: string;
  usage: {
    toolCalls: { used: number; limit: number };
    modelTurns: { used: number; limit: number };
    repairs: { used: number; limit: null };
    usd: { used: number; limit: number };
    durationMs: { used: number; limit: number };
  };
  pending: string[];
  lastFailure?: { tool?: string; message: string };
  summaryError?: string;
}
```

- [ ] 添加 result 协议新旧兼容测试和预算原因测试；同一结果中只使用实际触发条件作为主要原因，其余未完成项放 pending，不能笼统说模型额度耗尽。
- [ ] 在触发处构造 stop 对象，集中收尾函数生成结果；最后失败摘要来自已记录的 workflow/tool 事件并截断，不暴露无关完整输出。
- [ ] 只在模型轮次、费用、耗时与信号均允许时，最多进行一次无工具总结。成功不改变 review 状态；失败保存 summaryError 并使用确定性总结；无余额不调用模型。总结的费用和轮次仍正常计数。
- [ ] 在结果卡片展示原因标题、工具/模型/修复用量、待完成项与最近失败，详情可折叠。示例：

```text
未完成：模型轮次已用完
工具 96/128 · 模型 64/64 · 修复 7 次／不限
最近失败：apply_patch 路径校验失败
待完成：局部验证、需求核对、最终评审
```

- [ ] 对 renderer-ipc 加入新旧事件数据，验证历史会话加载。用本地固定数据检查卡片，避免真实模型消耗；如当前测试不支持组件渲染，用已有桌面烟测脚本验证文本与折叠交互，不为此引入新框架。
- [ ] 提交 `feat: show precise run stop reasons and remaining work`。

## 任务 5：组合回归与交付检查

**文件：** 新增 tests/agent-loop-recovery-regression.test.ts；更新 docs/agent-loop.md。

- [ ] 用隔离临时 Git 仓库、真实 apply_patch 和假模型重放故障链：依赖探测 → 新建探测脚本 → 显式请求验证 → 验证通过 → diff → 需求核对 → 最终评审 → completed。使用默认工具 128 次、模型 64 轮和修复不限的配置，禁止调用真实模型或用户业务仓库。
- [ ] 再重放失败路径：脚本校验失败 → 诊断 → 修复 → 验证；以及五次失败恢复后仍可完成。断言额度未耗尽时不会因修复次数而停止，真实工具/模型耗尽时分别显示 tool_call_limit/model_turn_limit。
- [ ] 验证危险路径补丁仍拒绝，失败/旧 revision 的验证证据不能支持完成；无验证配置不伪装 passed；仅因失败而退出的任务仍有可读摘要。
- [ ] 更新 agent-loop 文档中的检查点、恢复计数、默认预算及停止原因说明。
- [ ] 运行相关测试后执行一次完整质量检查；测试输出必须记录实际结果。

```powershell
node node_modules/vitest/vitest.mjs run --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
pnpm -r --if-present run build
```

- [ ] 查看最终 diff，确认预算默认值和 Profile 迁移仅包含用户指定的 128/64/修复不限调整，未修改其他用户设置、会话数据或权限策略。提交 `test: cover end-to-end agent recovery and verification boundaries`。

## 实施顺序与交付

任务 1 → 任务 2 → 任务 3 → 任务 4 → 任务 5。每步先建立失败用例，再实现、验证、提交。先完成代码与测试，安装包作为后续发布步骤；本计划不执行安装或覆盖用户应用。

预期交付：四项修复、组合回归测试、工作流文档、精确停止原因卡片和验证记录。若实施中发现协议兼容性问题，先修兼容层，再推进 UI。

## 计划自检

- 四项用户需求分别对应任务 1–4，任务 5 验证组合效果。
- 默认工具 128 次、模型 64 轮、修复不限，权限和完成门槛保持明确约束；历史证据表保留当时的 64/24 真实配置。
- 验证检查点不依赖放宽 shell 权限，恢复次数不依赖失败链重置。
- 新接口、字段、事件兼容和假模型场景均在所属任务中定义。
- 计划中的 runScenario 新模式均要求在现有测试辅助函数中实现；未声称已有这些用例。



## 实施记录（2026-09-09）

- 在 codex/agent-loop-recovery 分支实施；采用当前共享工作目录，未移动用户项目。
- 任务 1 的补丁回归落在 tests/patch-validation.test.ts，真实 Git 与路径防护 49 项通过。
- 任务 2、3、5 的引擎组合用例扩展现有 tests/workflow-engine.test.ts，而非复制同一夹具到新的文件。覆盖真实新建补丁、探测后创建脚本再验证、五次修复后完成、恢复旧检查点保持计数。
- 修复恢复消息以 assistant 结尾时 pi-agent-core 不能 continue 的实际边界：保留历史，追加运行时恢复指令后继续。
- 任务 3 配置迁移使用 Profile.budgetPolicyVersion=1，tests/budget-migration.test.ts 覆盖加密数据库重开、幂等、旧配置及历史 RunSpec。
- 任务 4 用现有 history-smoke.cjs 扩展桌面烟测，34 项通过，包含旧会话、真实卡片渲染、折叠和保存不限修复设置；无真实模型调用。
- 独立审查发现恢复中的预算错误类型丢失、只读任务门槛误展示及只读错误摘要遗漏；已建立失败用例并修复。只读停止列出分析结论与未检查范围，不强加代码修改门槛。
- 首次完整套件 227/228 通过，唯一失败是旧持久化测试仍期待三次自纠正；按用户新政策更新为 null，保留旧数值兼容性专项覆盖。
- 最终通过后集中提交本次相互关联改动；不生成或安装发行包。


## 最终验收

- [x] 标准新建/删除文件补丁通过，越界补丁继续拒绝。
- [x] 依赖探测不直接启动验证，显式检查点和准备结束均由运行时验证。
- [x] 修复和工具自纠正不限次数，默认工具 128 次、模型 64 轮；迁移幂等，历史 RunSpec 不改写。
- [x] 恢复同一 run 保留修复计数，兼容旧检查点与 assistant 结尾的历史。
- [x] 停止卡片展示实际原因、计数、最近真实失败和正确待完成项；合法 skipped 验证不充当最近失败。
- [x] 最终完整测试 37 个文件、232 项全部通过。
- [x] TypeScript --noEmit、全项目 ESLint、git diff --check 通过。
- [x] pnpm -r --if-present run build 成功；仅有现有 Zod 注释和前端大分块警告。
- [x] 桌面固定数据烟测 34 项通过，无真实模型请求或用户业务数据修改。

实施以一个完整提交交付在 codex/agent-loop-recovery 分支；未执行推送、合并或发行包安装。
