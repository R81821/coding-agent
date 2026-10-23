# 输入缓存未命中诊断（2026-10-22）

数据来自正在运行、已解锁应用的只读 daemon API。未读取密钥，未调用模型 API，未修改业务代码。diagnostics.json 仅保留用量、哈希、长度和事件类型，没有提示词或工具输出正文。

## 已确认的主要原因

最近任务 run_3e675f4a-bc7d-4949-844c-2ea0c446c131 使用 deepseek-flash + dsh，共 34 次主请求。任务运行中两次改变 Responses instructions，客户端诊断均为 rewrite，供应商均只返回 512 缓存 token。

| 上海时间 | 触发条件 | 系统文本字符数 | 输入 token | 缓存 token | 未命中 token |
| --- | --- | ---: | ---: | ---: | ---: |
| 15:24:59 | 本任务首请求，带入上一轮会话历史 | 3901 | 74385 | 7552 | 66833 |
| 15:26:35 | advance_workflow configure 建立 4 个节点，intent 仍为 analysis | 8355 | 103271 | 512 | 102759 |
| 15:27:33 | 首次 patch 使 intent 转 change；暂停恢复后注入实现指导 | 10348 | 113940 | 512 | 113428 |

长度与当前 buildInitialMessages 完全吻合：基础系统 3901；增加任务图指导 4454 后为 8355；再增加实现与运行指导 860+1133 后为 10348。工具 schema 的哈希全程相同，附件数为 0；本任务没有上下文压缩。

两次 rewrite 合计 216187 未命中 token，占本任务主请求未命中的 60.99%。加首请求的冷前缀，三次占 79.85%。其余 31 次 append 请求加权命中 98.50%。

## 汇总与排除项

- 最近任务主请求命中 92.98%，计入一次记忆请求后总命中 92.92%。
- 同会话前一任务主请求命中 93.87%，24 次主请求均保持 first/append，无 rewrite；加记忆后总命中 93.40%。
- 当前任务未发生 compaction；记忆请求仅输入 3172 token，不是这次主要损失。
- dsh 的身份与版本缓存键在切换时会改变，但同任务保持固定。动态状态仍位于追加的 base_snapshot/dirty_diff 中，没有每轮插入系统前缀。
- 官方 DeepSeek Responses 的 store=false 是既有兼容行为；服务端 KV 缓存不依赖 previous_response_id。

## 对应代码和建议

- packages/core/src/context.ts:126-130：按 intent/steps 添加实现及 DAG 系统段。
- packages/core/src/engine.ts:1515：阶段改变后组装新的 policy 快照。
- packages/providers/src/adapters.ts:153：将全部 system/developer 重新拼为头部 instructions。

上次接入 dsh 保留了原有按阶段重建系统段的行为。已有测试证明刷新生效，但没有要求阶段切换仍保持线级前缀稳定。

建议将可复用指导固定为带适用条件的系统前缀，阶段、任务图和当前状态仅更新末尾运行时上下文，并增加跨 configure/首次 patch/恢复的 adapter 请求前缀回归。不要通过改统计分母或隐藏低命中请求改善显示。

官方缓存规则：https://api-docs.deepseek.com/guides/kv_cache/
