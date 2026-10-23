# npqo 仪表盘 Agent 运行审计摘要

本摘要于 **2026-10-19** 检查已有本地审计文件后生成；以下执行时间均为 **2026-10-18、Asia/Shanghai**。本次复核没有继续查询 RPC、操作 UI、修改 npqo 或执行构建与测试。

**仪表盘已经生成，构建、9 项测试和三个宽度的浏览器检查有实际通过回执；但 Agent 会话最终以 `failed` 结束，没有完成正式需求验收和最终报告。** 不能把产物可运行与会话成功收尾混为一项结论。

## 本次运行

| 项目 | 记录 |
| --- | --- |
| Run | `run_a566d631-77eb-418e-ac99-c252a35395ef` |
| Session | `session_e7761fe9-98ec-4663-bc51-aace34762593` |
| 项目 | `D:\npqo`；发送前只有 `AGENTS.md`，没有 Git 仓库或 package.json |
| 实际模型 | `openai-compatible / deepseek-flash`；`reasoningEffort=max`，桌面 UI 显示 Ultra |
| 原始附件 | 1 张 `PixPin_2026-10-14_21-58-13.png`，`image/png`，`untrusted_attachment`；首个成功请求的 attachmentCount=1 |
| 开始 | 16:45:30.423 |
| 结束 | 17:11:35.821 |
| 墙钟耗时 | **26 分 05.398 秒**；runtime 记录 26 分 05.395 秒 |
| 最终状态 | `failed / provider_error`，阶段 `requirements_check` |
| 最后待办 | 当前修改 diff 检查、逐项需求验收、当前版本最终报告 |

原始 PNG 文件头尺寸为 822×1209；ingested attachment 的 run 元数据未给宽高，不能据此断言转换后的模型输入尺寸。成功请求证明附件被发送并被接口接受，不单独证明视觉理解质量。

## 实际验证证据

最终 revision 22 的本地验证在 **17:10:17.954** 完成，事件 sequence **2589**，验证 ID `verify_366ac408-adc7-4911-9977-bb1642ee430e`：

| 命令/检查 | 实际结果 |
| --- | --- |
| `npm run build` | exit 0；入口执行 `tsc --noEmit && vite build` |
| `npm run test -- --reporter=verbose` | exit 0；2 个文件、9 项测试通过 |
| `npm run screenshots` | exit 0；实际启动已安装的 Chrome 和 5181 preview，验证模式把临时截图写在临时目录 |
| 1440×1000 | 4 列卡片；room 1372×686；脚本 no overflow |
| 1024×900 | 2 列卡片；room 975×455；脚本 no overflow |
| 390×844 | 1 列卡片；room 368×300；脚本 no overflow |
| 暂停/单步/恢复 | held tick 1 → stepped 2 → resumed 3，通过 |
| 图表 hover | 输出 tooltip `DAY 11 / TICK 0-27 $71,914.80`，通过 |

最终 broader 验证在 **17:10:35.523** 完成，sequence **2616**，ID `verify_088cfb8c-bb30-4cf1-9da9-b4ba21c5a591`：`npm run test` 和 `npm run build` 均 exit 0、passed=true。最后工作流的 local/broader 都标记为 revision 22 已通过，scaffold/tests/screens 三步骤均 verified。

三宽交付截图在此前 **17:04:20 起** 的 `npm run screenshots:save` 中实际保存成功（工具 `call_00_ZNk7Foezm0VwGv7uwsG32874`，exit 0），包括 `screenshots/dashboard-1440.png`、`dashboard-1024.png`、`dashboard-390.png`，以及像素房间和 hover 附加图。后续 verify 模式再次检查浏览器行为，不能把它描述成又覆盖保存了一遍交付截图。

9 项测试覆盖：相同 seed 的确定性、不同 seed 的差异、每 tick 的金融/8 Agent 状态一致性、数值格式、8 卡与房间/图表渲染、同一 tick 联动、暂停/单步/恢复、tooltip、orderbook/threshold 共用 snapshot。

本地事件共含 8 次 verification_finished（6 通过、2 失败），18 条 verification_cache_decision 均为 `source=executed`、`cached=false`，没有把缓存命中当作新执行。自动测试通过证明脚本中的断言通过；参考图相似度、像素表现和小屏可读性仍需独立看图评分。

## 审批次数和等待时间

- 共 **35 次计划审批请求，35 个独立版本获批**；approvedBy 全为 `desktop:user`。此外有 **35 次工具权限审批请求**。
- 将每个 plan_approval_required 与同 plan/version 的 approved 事件配对：计划等待合计 **3 分 48.257 秒**。
- 将 status 进入 waiting_approval 至退出该状态的区间相加：全部审批等待合计 **5 分 33.184 秒**，包含计划和工具等待，不能再与前项相加。它是事件时间推算，不是独立的点击耗时计量。
- 最长一次计划等待为 v9，**84.529 秒**。主评估者报告这次由其通过 UI 批准，并留有 `agent-plan-approval-v9.png`。其余 `desktop:user` 只能确认桌面端身份，日志不能区分具体物理操作者。
- 审批摘要大量使用 `Execute terminal` 等通用文字，难以从摘要判断具体操作，形成额外阅读与点击成本。批准是任务权限操作，不计为评估者补写代码或追加实现提示。

## 用量

| 指标 | 审计记录 |
| --- | ---: |
| Runtime 模型轮次计数 | 60 / 64 |
| Runtime 工具预算计数 | 78 / 128 |
| 实际 tool_call / started / finished 事件 | 各 68 |
| tool_finished 标记错误 | 9 |
| model_request_finished | 59（58 成功、1 失败） |
| 主任务输入 / 输出 tokens | 15,749,577 / 163,934 |
| 主任务 cached input tokens | 15,418,112 |
| 主任务 reasoning tokens | 88,750 |
| Compaction 输入 / 输出 tokens | 466,492 / 2,842 |
| 全部 usage 回执输入 / 输出合计 | **16,216,069 / 166,776** |

token 数是各次接口 usage 回执之和，重复上下文会重复计入。cached input 和 reasoning 是回执的分项，未再次加到输入/输出合计。成本 `costKnown=false`，日志中的 estimatedUsd=0 不足以证明没有费用。runtime 的预算计数与可见工具事件数口径不同，均按原值保留。

## 主要故障与恢复

1. **空目录非 Git 仓库**：首次 git status 报错；Node/npm 自身成功。后期再次调用 git_diff 仍因非 Git 失败。项目本来就没有 `.git`，不能把此错误说成应用代码构建失败。
2. **工作流证据引用错误**：configure 引用不存在的 evidence ID，terminal 观测也未被 gate 认作仓库证据。Agent 随后 read_file/search_files，用真实观测重新配置成功。
3. **Windows 长命令失败**：写 PixelRoom 的单条 terminal 命令长 32,600 字符，返回 `spawn ENAMETOOLONG`。随后改用较短命令及 stdin 传源码，继续实现。
4. **端口冲突**：5173 实际为 Harness 自身，浏览器首先得到 Harness Agent。Agent 读 HTML 自行定位后改用 5180，后续访问正确仪表盘；正式截图脚本用 5181 preview。
5. **真实 tooltip 测试失败**：初次 9 测试中 1 项因 undefined.toLocaleString 失败。Agent 同时修正 hover 索引/兜底与 jsdom pointer 事件构造，后续 9 项通过，未删除该测试。
6. **截图验收迭代**：先遇到 favicon 404、未添加 screenshots:save 脚本、SVG 子图形 bbox 被 overflow 检查命中等问题；之后补脚本/资源并调整检查，三宽保存和验证通过。截图写入工作区还导致一次运行时文件指纹失效；之后区分 save 模式与临时 verify 模式，最终 local/broader 通过。
7. **最终收尾未恢复**：最后 workspace_diff 输出 `complete=false, truncated=true`，工作流 diffRevision=-1。即使 local/broader 已通过，check_requirements 仍以缺少完整当前 diff 拒绝验收。随后 compaction 后的模型请求实际设置 **maxOutputTokens=961132**，而该 provider 允许上限 **393216**，HTTP 400 直接终止运行。请求诊断是明确证据；这属于 Agent/运行时收尾链路故障，不能归因为 React 仪表盘运行失败。

## 证据索引

- `agent-final-result.json`：最终失败状态、provider 错误、预算与待办。
- `audit-summary.json`、`run-events.jsonl`：本次单一 run 的完整事件和采集快照；最后 sequence 2729，共 2730 事件。
- `tool-outputs/`：各工具真实命令与输出；不含截图 base64。
- `final-audit-metrics.json`：本次离线汇总的时间、用量、审批等待、验证和故障数据。
- `attachment-and-model-evidence.json`：附件/模型元数据及成功请求证明。
- `evaluator-interventions.json`、`agent-plan-approval-v9.png`：已知评估者 UI 批准行为；没有代写 npqo 或补充实现提示。

本摘要只汇总 10 月 18 日原 run。目录中的 10 月 19 日 `final-review-build.log` / `final-review-vitest.log` 属于之后复核，不冒充原 run 的新执行或原 Agent 自行完成证据。
