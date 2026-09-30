# 输入缓存优化说明

本次参考 Hermes Agent 的稳定提示词分层、冻结工作区快照和逻辑缓存身份机制，将动态状态移到消息尾部。Hermes 源目录仅用于阅读，未作修改。

## 七项实现

| 方案 | 当前行为 | 主要代码 |
| --- | --- | --- |
| 固定 System Prompt | 安全规则、Profile 提示词和编码规则组成稳定前缀；工作区、预算、记忆、项目内容移到上下文消息；不会把时间或当前 diff 插入系统前缀 | `packages/core/src/context.ts` |
| 固定工具定义 | 按工具名排序，递归排序 JSON 对象键；保留数组语义；一次 Agent Loop 固定工具契约 | `packages/protocol/src/prompt-cache.ts` |
| base snapshot + dirty diff | 先发送有界项目根目录与工作状态快照，后续仅在尾部追加 set/remove/append 差量；压缩时重新建立基准 | `packages/core/src/prompt-cache.ts`、`pi-agent-bridge.ts` |
| 按需读代码 | 提示先 search_text，再 read_file、read_range；read_file 默认最多 16 KiB，截断后提供范围读取指引；read_range 为一基行号、闭区间，最多 500 行及 64 KiB | `packages/tools/src/builtins.ts` |
| 稳定缓存 key | 主循环请求使用应用版本和规范化仓库路径身份的哈希，避免将 run ID 或时间加入 key；OpenAI 与兼容适配器传递 prompt_cache_key | `packages/core/src/prompt-cache.ts`、`packages/providers/src/adapters.ts` |
| Responses 连续响应 | 同一运行内保存完成响应 ID，核对已有上下文前缀后仅发送新增输入；每次重发稳定 instructions；历史、模型或工具改变时重建响应链；过期 ID 回退一次完整本地上下文 | `packages/providers/src/adapters.ts` |
| 命中率统计 | 用量事件保存 cachedInputTokens，界面显示输入、命中、未命中和统计覆盖；兼容 OpenAI、DeepSeek、Anthropic、Gemini 的返回字段 | `packages/protocol/src/prompt-cache.ts`、`apps/desktop/src/components/PromptCacheStats.tsx` |

## 使用与边界

- Profile 中的“Responses 连续响应”默认启用，使用服务端保存的响应上下文；关闭后使用本地完整历史和 store=false。其他 API 不使用 previous_response_id。
- 响应链仅限当前运行；重启、上下文压缩或恢复时，允许重新发送本地完整上下文。失败、不完整或意外结束的流不会成为下一轮续接依据。
- 命中率按有缓存字段的请求计算：sum(cachedInputTokens) / sum(inputTokens)。不平均每次请求的百分比。未返回缓存字段的请求不作为零命中，另行显示统计覆盖。
- prompt_cache_key 和 previous_response_id 都不保证缓存命中。实际表现仍取决于服务端支持、前缀长度、缓存保留和请求间隔。连续响应也不意味着历史输入免费。
- 测试使用本地模拟响应，未调用真实模型，因此当前没有真实优化前后命中率对比。旧事件缺少缓存字段时显示未知；更新后正常运行即可收集数据。
- 成本估算继续沿用原有输入单价，未将缓存价格折扣写成确定节省金额。

## 验证记录

2026-09-10：43 个测试文件、261 项测试全部通过；pnpm typecheck、pnpm lint、pnpm build 全部通过。覆盖稳定前缀、JSON 排序、状态差量重建、范围读取、工具结果续接、响应链过期/中断恢复、缓存字段与界面统计，以及原有权限、会话、工作流和预算回归。

发现并修复上下文压缩额外模型请求未计入轮次的问题；压缩请求现在占用模型额度，并在不足时使用确定性摘要，保留 64 次模型轮次上限。

此验证完成源码与构建产物更新，未生成新的 Windows 安装包。

## 参考

- Hermes：`agent/system_prompt.py`、`agent/coding_context.py`、`agent/prompt_cache_scope.py`。
- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

## 2026-09-27 升级

本次按[缓存诊断与优化方案](prompt-cache-optimization-report-2026-09-27.md)实现源码升级，覆盖摘要、旧配置迁移、上下文重建和统计。历史采样命中率不能当作升级后的效果。

- 已确认的 DeepSeek 官方地址：Chat Completions 摘要发送 `thinking.type=disabled`，Responses 摘要发送 `reasoning.effort=none`。主任务沿用原配置。其他地址或 Provider 使用程序摘要，不推测兼容参数。
- 模型摘要输出上限保留 2,048 tokens；输入包含原始任务、结构化运行状态和完整历史记录，按记录选择，不截断 JSON。正文必须满足字段、长度和条目类型校验。已知证据和待办独立保留，不因模型遗漏而丢失。
- 摘要结果区分采用、截断、空正文、无效 JSON、供应商错误、预算不足、不支持、失败后停用和目标回退。失败一次后，该运行后续使用程序摘要；恢复同一运行时从压缩记录恢复停用状态。已发生的用量和耗时仍计入预算。
- 保存的旧默认比例 `0.70/0.80` 在读取时迁移为 `0.80/0.45`，保留 `contextPolicyMigration.previous` 与原因。自定义有效配置不变；目标不低于触发线的旧配置会记录原值后规范化。新写入必须满足目标小于触发线。迁移生成新的配置对象，不修改活动运行已有对象。
- 有证据读取能力时，普通工具结果首次发送采用有界预览并保留证据 ID。完整结果仍在原事件记录中。`read_evidence` 自身已限制分页范围，不进行二次截断；可信技能正文也不裁剪。独立 bridge 调用没有证据读取工具时不启用新增的首次限长。
- 超阈值时批量裁剪或压缩到配置目标，记录调整前后估算、容量与目标。保留工具配对、错误、原始任务与用户补充要求；程序摘要继承上一轮摘要事实。必要要求无法放入目标容量时明确返回 `context_budget_exceeded`。
- `context_adjusted` 记录首次限长、历史裁剪、完整压缩、恢复和配置迁移；`cache_diagnostic` 在适配完成后、发送前记录请求用途和前缀变化。诊断只持有有界数量的哈希与长度，不新增 prompt、代码或密钥正文日志。
- 前缀统计比较适配后的完整消息项；字符数是相同消息项字符长度之和，不包含半个消息，也不等于缓存 tokens。Responses 尾部续接标记 `continuation`，过期续接重发完整输入标记 `continuation_fallback`，二者不虚报共同前缀长度。
- 界面分别显示主调用和全部用途的加权命中率，以及摘要采用次数、裁剪与重写事件。无模型摘要记录显示“不适用”，旧事件无新增字段时不推断结果。裁剪和重写次数只覆盖有相应事件的请求。

实际模型容量、主任务推理预算与估算误差仍需受控真实任务校准；本次没有擅自降低主任务输出上限，也未把 85% 主调用命中率或 20% 未命中输入降幅写成已达到的指标。程序摘要策略可能增加保留事实的体积，这是避免遗漏要求的取舍。

本次回归、构建结果和交付边界见[升级验证记录](prompt-cache-upgrade-2026-09-27.md)。
