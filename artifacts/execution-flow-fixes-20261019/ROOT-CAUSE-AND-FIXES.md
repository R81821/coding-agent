# 执行流程低分复盘与修正

实施日期：2026-10-19；最终复核日期：2026-10-20（客户端日期）。修正对象：D:\qweai 的 coding-agent 运行时。依据是 npqo 仪表盘实测的原始事件、工具回执和最终失败结果。

原评估：综合 78/100，其中页面产物 82/100、执行流程 60/100。原 run 花费 26 分 05 秒，实际构建、测试和截图成功，但最终状态 failed。本次保留这些原始结论，不把回归测试通过当作真实模型重测后的新分数。

## 低分现象、根因与改正

| 原运行现象 | 根因 | 本次改正 | 验证重点 |
|---|---|---|---|
| 最后 HTTP 400，maxOutputTokens=961132，provider 上限 393216 | 摘要请求使用 Infinity；未知模型输出能力也视作 Infinity；把剩余上下文容量当作输出能力 | 摘要默认独立 32768 上限；所有请求都有有限输出上限；provider 可单独配置输出能力，不与上下文窗口混用 | 小摘要批次、未知能力、显式配置、实际发给 provider 的参数 |
| 非 Git 新项目 diff 永远 incomplete，无法进入需求验收 | 基线正文按文件 64KB、总计 384KB 截断，没有完整保存和后续读取机制；桥接层还会再次按 8KB 截断工具结果 | 加密保存基线正文，按不超过 80KB 的 UTF-8 JSON 分页；读完所有页才 complete；workspace_diff 的合规分页结果完整到达模型 | 大文件中段/尾部可见；分页重建一致；漏页、重放、文件变更、缺历史正文不能冒充完整 |
| 35 次 plan 审批叠加 35 次 tool 审批，常只显示 Execute terminal | 同一操作经过两套批准；历史 plan 把每次操作继续累积 | 现代 workflow 由 PermissionEngine 和具体工具审批授权，plan 记录实际获准操作；旧 workflow 保留原流程；标题显示具体命令、路径及 stdin 摘要；自动授权精确绑定命令和路径参数 | 不重复 plan 弹窗；拒绝、过期、暂停不执行；命令追加参数、path/filePath/cwd 变化须重新批准；明确的既有 scope 仍可复用 |
| 截图一写入，已经成功的 build/test 都被标记失效 | 验证只比较仓库指纹，没有区分已声明的检查输出与代码输入 | 计划和实际验证调用必须共同声明 generatedArtifactPaths；仅允许新建、媒体头签名正确且与快照一致的指定媒体输出；回执绑定执行后指纹；此处不做完整图片解码验证 | 新 PNG 可通过；改源码、覆盖输入图、缺少媒体签名的伪装文件、未声明输出、计划与调用不一致仍拒绝 |
| Windows 写入大脚本触发 spawn ENAMETOOLONG | 未在 spawn 前计算 Windows 实际 argv 经过转义后的长度 | 预先按 libuv 引号规则及 UTF-16 单位检查 32767 上限；返回结构化可恢复错误，提示文件工具或短解释器命令加 stdin | 32767/32768 边界、emoji、转义引号与反斜杠、原 32600 字符量级、stdin 不算 argv |
| 累计输入约 1622 万 tokens；摘要阶段大批上下文重复 | 完整历史计划与授权命令，包括内嵌脚本，反复作为固定上下文发送 | 固定上下文的 approvedPlan/permissionSnapshot 改用有界历史摘要、命令预览、长度和摘要值；完整审计仍保存，实际授权始终检查原始 grant；原会话的工具调用仍可能含完整命令和脚本 | 40 份大脚本/授权 fixture 的投影小于 16000 字符，原始对象保持完整，不以截断预览执行授权 |

原运行中还有业务断言缺口（同名金额、成交量时间轴、持续悬停、手机房间完整性）。本次没有替 agent 修改 npqo 的页面产物；这些问题继续保留在原评估中。运行时提示已补充端口身份检查和输出声明方式，但不能仅靠提示保证未来产物的业务正确性。

## 实现边界

- 自动命令授权使用原始命令精确匹配，不能靠 trim、追加参数或引号变化扩张；用户原先明确配置的 prefix scope 保持原语义。
- 自动授权还精确绑定 path/filePath/cwd 三个路径字段的原值与缺省；字面 `*` 不会变成授权 glob，删除字段不能扩大授权。显式配置的 `**` 范围继续按既有协议语义处理。
- 上述绑定针对普通工具授权输入中的路径参数。验证引擎的实际工作目录由已匹配的验证计划和工作区约束决定，内部 terminal 授权调用尚未携带 item.cwd；本次不能宣称所有执行通道均按实际工作目录单独授权。
- terminal 的非空 stdin、浏览器输入/上传/下载以及已识别的 destructive 操作继续逐次批准。MCP/probe 的 stdin 沿用其原有工具作用域规则；不能把本次改动描述为所有工具均逐参数一次性审批。
- 未知模型输出能力回落为有限的 393216；若服务实际上限更低，仍须由模型元数据或新配置设置正确上限。本次消除了已复现的摘要余量膨胀，不代表能自动识别所有第三方服务的上限。
- 验证输出豁免只针对指定的新媒体文件，不是忽略整个 screenshots 或 artifacts 目录。重复截图应使用新文件名或临时目录；覆盖已有图片仍会使检查失效。
- 分页 diff 在覆盖不完整时仍拒绝验收；有界扫描和基线存储不能成为伪造 complete 的理由。
- 本次保留工作区原有未提交改动，未提交、推送或打包安装程序。

## 验证记录

针对性测试已经覆盖真实 engine、PermissionEngine、数据库、checkpoint、tool bridge 和文件快照；provider/进程等外部副作用在相应 fixture 中受控模拟。它们能证明这些运行时路径的回归行为，不能替代再次使用真实模型完成 npqo 任务。

首轮完整测试：222 个测试文件，220 通过、2 失败；2108 个测试，2105 通过、3 失败。两项是旧 plan 生命周期 fixture 默认走到现代 workflow；已固定为真实 legacy 路径并保留原审批恢复断言，独立重跑 13/13 通过。另一项 MCP HTTP 测试触发内部 5 秒超时，单文件重跑 35/35 通过，原失败项耗时 712ms；尚不能据此断言超时的具体调度根因。未通过放宽生产超时或删除断言来处理该项。

最终检查（客户端日期 2026-10-20；使用项目默认测试配置，4 个 worker）：

| 命令 | 最终结果 |
|---|---|
| pnpm test | 223 个测试文件、2132 项测试全部通过；226.54 秒；包含 MCP、legacy 计划生命周期和新增精确路径范围回归 |
| pnpm lint | 通过，退出码 0 |
| pnpm typecheck | 通过，退出码 0 |
| pnpm build | 通过，退出码 0；覆盖有 build 脚本的 workspace 应用，包含 desktop/web/daemon/CLI/gateway |
| git diff --check | 通过；Git 的 LF/CRLF 提示不影响退出码 |

构建日志保留第三方 Zod 注释位置的 Rollup 警告；本轮没有为这些非阻断警告修改依赖。所有检查均在本机实际执行。没有再次向原第三方模型提交完整 npqo 任务，因此不重新给执行流程评分，也不声称审批耗时、token 用量或成功率已获得真实任务的量化提升。

## 主要代码入口

- 输出与摘要预算：[generation-policy.ts](D:/qweai/packages/core/src/generation-policy.ts)、[context-summary.ts](D:/qweai/packages/core/src/context-summary.ts)
- 授权与验证接线：[engine.ts](D:/qweai/packages/core/src/engine.ts)、[grants.ts](D:/qweai/packages/tools/src/grants.ts)、[security.ts](D:/qweai/packages/core/src/security.ts)
- 固定上下文投影：[authorization-context.ts](D:/qweai/packages/core/src/authorization-context.ts)
- 非 Git 分页及传输：[workspace-diff.ts](D:/qweai/packages/core/src/workspace-diff.ts)、[pi-agent-bridge.ts](D:/qweai/packages/core/src/pi-agent-bridge.ts)
- 生成输出分类：[verification-artifacts.ts](D:/qweai/packages/core/src/verification-artifacts.ts)
- Windows 长命令诊断：[windows-command-line.ts](D:/qweai/packages/tools/src/windows-command-line.ts)
- 引擎回归：[modern-authorization.test.ts](D:/qweai/tests/modern-authorization.test.ts)、[verification-artifacts-engine.test.ts](D:/qweai/tests/verification-artifacts-engine.test.ts)、[workspace-diff-bridge.test.ts](D:/qweai/tests/workspace-diff-bridge.test.ts)

## 可复算证据

- 原评分与问题：[FINAL-REVIEW.md](D:/qweai/artifacts/npqo-dashboard-eval-20261018/FINAL-REVIEW.md)
- 原 run 指标：[final-audit-metrics.json](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-audit-metrics.json)
- 首轮完整测试：[full-test.log](D:/qweai/artifacts/execution-flow-fixes-20261019/full-test.log)
- MCP 独立复测：[mcp-test.log](D:/qweai/artifacts/execution-flow-fixes-20261019/mcp-test.log)
- 路径授权专项 85 项：[vitest.log](D:/qweai/artifacts/flow-remediation-20261019/path-scopes/vitest.log)
- 最终完整测试：[final-full-test.log](D:/qweai/artifacts/execution-flow-fixes-20261019/final-full-test.log)
- 最终构建：[final-build.log](D:/qweai/artifacts/execution-flow-fixes-20261019/final-build.log)
- 最终 lint：[final-lint.log](D:/qweai/artifacts/execution-flow-fixes-20261019/final-lint.log)
- 最终类型检查：[final-typecheck.log](D:/qweai/artifacts/execution-flow-fixes-20261019/final-typecheck.log)
