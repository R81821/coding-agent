# Harness 1.3.2 与 Hermes 同题运行对比

检查时间：2026-09-10。此次只做分析，没有修改应用逻辑，也没有发起新的模型请求。

## 对比对象与证据边界

问题完全相同：**检查memory模块，分析得出可优化方案**。仓库均为 `D:\ap\deeplearner`，模型均为 `deepseek-v4-flash`。

- Harness：`run_2a5a7f21-1e69-4b07-8ecc-3dc4959df61b`，2026-09-10 10:58:25 至 11:14:09，状态 review / model_turn_limit。
- Hermes：`20260910_111003_a82fc7`，11:10:05 用户消息至 11:12:54 输出方案，并调用 clarify 等待实施范围选择。
- Harness 运行进程在 `D:\qweai-harness\Harness Agent`。只读 daemon health 确认 1.3.2，安装版 daemon/main.js 与当前构建文件 SHA-256 相同。
- Harness 配置为 `https://api.deepseek.com`，Hermes 为 `https://api.deepseek.com/v1`。二者指向同一官方服务，不能据此把差距归因于换了模型或第三方中转。
- 桌面读取工具两次因 `windows sandbox failed: helper_unknown_error` 启动失败。因此没有直接查看窗口滚动位置、视觉渲染或当前所选任务；对比依据是正在运行的应用、最新匹配题目的本地记录与源码。
- 原始诊断快照保存在 `D:/qweai/.cache/cache-audit/`。读取了 Harness 事件及最后三份检查点、Hermes 只读 SQLite 会话和 agent.log；没有读取 API 密钥。

## 实际指标

| 指标 | Harness | Hermes |
| --- | ---: | ---: |
| 从任务提交到本次回答 | 943.84 秒（15 分 44 秒） | 168.63 秒（2 分 49 秒） |
| 主循环模型请求 | 50 | 15 |
| 已记录辅助模型请求 | 14 次上下文摘要 | 9 次智能审批 |
| 模型发起工具调用 | 108 | 31（最后一次 clarify 待用户回答） |
| 已完成模型工具调用 | 107 | 30 |
| 上下文压缩 | 15 次，14 次调用模型、1 次确定性回退 | 本轮未发现压缩 |
| 主循环输入 tokens | 2,823,267 | 726,453 |
| 主循环缓存命中率 | 54.70% | 92.42% |
| 主循环输出 tokens | 110,630 | 15,694 |
| 主循环加已记录辅助调用：输入 tokens | 3,397,700 | 730,643 |
| 主循环加已记录辅助调用：命中率 | 45.45% | 91.99% |
| 主循环加已记录辅助调用：输出 tokens | 180,803 | 16,364 |
| 结果 | 轮次耗尽，仍待复核 | 给出优化方案，等待实施范围选择 |

计数说明：Hermes 的 `input_tokens` 是未缓存输入，其总输入应加 `cache_read_tokens` 和 `cache_write_tokens`。主循环为 55,093 + 671,360 = 726,453；不能拿 55,093 直接与 Harness 的总输入相比。Hermes 的辅助统计还不包含那次失败的标题生成请求，不能声称其所有 HTTP 尝试只有 24 次。输出 tokens 是服务端生成量，可能包含推理，不等于用户看到的正文长度。

Harness 的工具执行时间区间合并后约 135.87 秒，人工审批约 3 秒；模型轮开始至最后 usage 的累计区间约 787.39 秒，包含模型生成、摘要及期间本地处理，不能当作纯网络延迟。Hermes 日志中 15 次 API latency 相加为 81.3 秒。两者模型计时口径不同，不用于精确网络速度比较。

## 1. 分析任务被工具风险等级改成修改任务

证据：[coding-workflow.ts](../../packages/core/src/coding-workflow.ts:90)、[builtins.ts](../../packages/tools/src/builtins.ts:137)。

`before()`、`starting()` 用工具风险是否为 read 判定 mutation。terminal 一律是 high 或 destructive，所以执行任何 terminal 都会设置 intent=change、递增 revision、失效旧证据与验证。

本次第一条 terminal 只检查数据库文件是否存在，并执行 SELECT 查询表、索引和行数；实际发生在 **10:59:01**。它使 revision 从 0 变为 1。后续 11 次 terminal 对应 revision 1 到 11，结束时 changedFiles 仍为空。临时探针可能有文件副作用，但这不等于用户要求变更仓库业务代码。

后果：模型先按分析任务读代码，随后被送进修改/诊断/验证/需求收据流程；探针失败被升级为修复工作流，既有代码证据不断过期。最后仍显示 small_edit、局部验证待办和需求收据缺失。

修复方向：保留执行权限检查；将权限风险、命令副作用和仓库代码版本分别建模。为只读分析、隔离探针、真实源码修改提供不同完成门槛。不得通过把所有 terminal 降级为 read 绕过安全检查。

## 2. dirty diff 被完整状态输出和滚动数组抵消

证据：[engine.ts](../../packages/core/src/engine.ts:401)、[coding-workflow.ts](../../packages/core/src/coding-workflow.ts:71)、[prompt-cache.ts](../../packages/core/src/prompt-cache.ts:23)。

- `getPinnedContext` 仍带完整 workingMemory，而 `update_workflow` 成功后也返回整份 snapshot。
- 本次 14 次 update_workflow 输出共 524,965 个字符；单次最高 57,905 字符，占全部工具输出字符量约 53%。
- 最后一次压缩的 workingMemory 约 55,182 字符，其中 observations 46,403 字符；同一次保留了约 55 KB 工具状态输出、约 45 KB git_diff 及约 68 KB 编码后的基准消息。
- observations 达 32 条后每次删首项再追加；差量算法只识别尾部 append，无法识别滑动窗口。因此每次滑动都会 set 整个数组。recentObservations 的 12 条滚动数组有相同问题。
- 用当前源码离线复现：32 条观察滚动一条，产生 `set observations`，重发全部 32 条，39,429 字符。

修复方向：update_workflow 返回短回执；原始观察留在可查询证据存储，模型仅接收必要摘要和引用。按观察 ID/序号发送新增、撤销和失效事件，避免滑动数组全量替换。预算计数等少量状态可以继续尾部追加。

## 3. 频繁压缩破坏缓存，还丢失工作记忆

证据：[pi-agent-bridge.ts](../../packages/core/src/pi-agent-bridge.ts:619)。

- 首次压缩前 14 次主模型请求，命中率 **86.27%**，说明固定前缀有效。
- 压缩后的 36 次主模型请求降至 **47.74%**。
- 14 次模型摘要共消费 574,433 输入、70,173 输出 tokens，cached_tokens 全为 0，占用了 14/64 模型额度。
- 多数压缩后的首轮仅命中 2,816 tokens；并非继续复用此前数万 tokens 的会话前缀。
- 两份“摘要”实际是 DSML 工具调用文本，其中 11:10:13 的摘要几乎只有伪工具调用；程序只检查非空便接受，没有检查摘要是否保留目标、证据和待办。
- agent/store.py、graph.py、history.py 在首次读取后又多次重读；read_range 未纳入 RunProgress 的重复读取检测集合。

容量控制也有问题：兼容模型 descriptor 固定 128,000，Profile 在 70% 即约 89,600 的估算量触发压缩；估算对整个 Pi 消息 JSON 除以四，工具内容同时存在 content 和 details，会把内部副本算入。官方当前列出的 DeepSeek-V4 上下文为 1M，App 没有读取该模型的真实容量。即便保留较小工作预算，也应明确区分它与模型硬上限，而不是错误地宣称已到模型容量边界。[官方模型信息](https://api-docs.deepseek.com/quick_start/pricing/)

修复方向：根据真实发送消息估算上下文，减少重复状态后再设工作预算；保证压缩后的目标显著低于触发阈值；保留有效证据和最近操作完整配对；校验摘要结构、长度和内容类型，失败时使用可信事实组成的确定性摘要。补充超过 32 条观察、多次工具失败和压缩后的长轨迹测试。

## 4. 当前 DeepSeek 调用路径没有使用新增的 Responses 续接

证据：[providers/index.ts](../../packages/providers/src/index.ts:52)、[adapters.ts](../../packages/providers/src/adapters.ts:290)。

当前 providerId 为 openai-compatible，走 `/chat/completions`。`previous_response_id` 只在 OpenAIProvider 中实现，Profile 的连续响应开关不会把 compatible provider 切换到 Responses。上一版新增能力没有覆盖用户正在使用的路径。

另有两个适配缺口：

- compatible 请求体没有传递 ModelRequest.maxOutputTokens。摘要虽在核心层设置 1,024 上限，但实际上没有写进 Chat Completions 请求；本轮摘要单次输出最高 10,950 tokens。输出指标包含推理，所以不能把它全部算成摘要正文，但预算参数缺失是确定问题。
- 适配器忽略 delta.reasoning_content，也不向后续工具轮传回该字段。Hermes 则有保存、复制 reasoning_content 的处理。DeepSeek 官方说明工具模式需要保留该字段。该轮未保存原始 SSE，且未看到相应 400 错误，因此这是确认存在的兼容性缺口，不能据此单独量化本次慢了多少。[官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[官方请求参数](https://api-docs.deepseek.com/api/create-chat-completion/)

修复方向：显式区分供应商与 API 协议能力，给 DeepSeek 设置正确元数据、输出上限和推理状态续传；对支持的 Responses 路径单独做工具续接测试。发送 prompt_cache_key 并不等价于服务端命中缓存。

## 5. 验证曾空跑，证据又因无关命令失效

第一次 local verification 执行 `& .venv/Scripts/python.exe -X utf8 -`，没有 stdin，949ms 返回 0、输出为空，却被记录为 passed。第二次验证还再次执行这个空命令，另一个 pytest 命令才真正得到 25 passed。

真实测试通过后，最终探针 terminal 又将 revision 从 10 推到 11，刚获得的验证和之前源码观察再次过期。模型的 requirements 请求被拒绝，最后因 model_turn_limit 停止。

修复方向：验证配置必须包含实际可执行的测试内容；stdin 驱动命令必须携带并执行对应脚本，或者拒绝这种不完整配置。证据新鲜度应依据文件变化、环境变化及依赖关系，不应因任意终端查询就失效。分析任务不应需要为不存在的源码变更完成修改评审。

## 6. 持久化进一步放大本地负担

证据：[engine.ts](../../packages/core/src/engine.ts:974)、[sqlite.ts](../../packages/persistence/src/sqlite.ts:55)、[pi-agent-bridge.ts](../../packages/core/src/pi-agent-bridge.ts:144)。

本轮时间窗口写入 402 份检查点，payload 共 257,255,241 字节（约 245 MiB）。整个库约 589 MiB，其中全部检查点 payload 约 550 MiB。每份检查点存完整 transcript；压缩后的 7 条消息检查点约 186 KB，很快又被未压缩的 agent.state transcript 覆盖为 163 条、约 1.24 MB。

SQL.js 每次写入触发 500ms 合并定时器，flush 通过同步 export + writeFileSync 重写整个数据库。此结构会增加事件循环阻塞和磁盘写放大，但本次没有 flush 时长采样，不能把未解释耗时全部归因于它。

修复方向：增量消息/事件持久化，加轻量检查点和保留策略；压缩后的模型上下文与完整审计历史分开存储。避免高频同步导出完整 SQL.js 数据库。

## 回答质量的具体差别

Hermes 将问题组织为窗口记忆质量、跨会话长期记忆、I/O 和测试四组，并指出“直接把摘要写回 checkpoint 会影响前端历史和标题”的耦合，较符合用户要可优化方案的目标。

Harness 也有价值：它提出 thread_id 归属风险、做了 N+1 与事件循环探针；不能说其所有内容都弱于 Hermes。但它花了大量轮次重复读代码、重做计划和维护验证收据，最终输出更像未收尾的审计记录。将自己探针误传参数引起的 TypeError 单列为产品优化问题，也挤占了更相关的记忆质量建议。

两边结果都不能当成独立验证的最终真理。例如 Hermes 称取证“只读”，但工具记录实际包含写入/清理历史文件的探针。此次没有复跑整个 memory 审计，回答质量评价限于目标覆盖、证据使用和交付完整性，不给虚假的百分制评分。

## 建议修复顺序与验收

1. 分离分析意图、执行风险和真实源码 revision，修正空验证命令。
2. 去掉全量工作流回包，修复滚动观察数组的差量表达与证据可检索性。
3. 补齐 DeepSeek 输出预算、推理状态及 API 协议配置，纠正模型容量元数据。
4. 重做压缩触发与摘要校验，让长任务保留有效证据并减少前缀重建。
5. 处理完整 transcript 检查点与 SQL.js 全库导出的写放大。
6. 用这次脱敏轨迹做离线长回归，再以同题、同模型、同推理档位、同仓库快照多次对比主循环与辅助请求指标。

验收应同时记录总耗时、主/辅助调用、输入/输出/缓存 tokens、压缩次数、有效证据保留、重复读取及用户可用的最终方案。不能只上调轮次，或用缓存命中率提高掩盖输入总量继续增长。

上一版固定前缀及短序列缓存测试通过，但未覆盖 32 条观察后的滑动、状态重复回包和真实终端使分析任务变成修改任务的长轨迹。本次真实运行暴露了这些遗漏，需要补针对性长回归，不能以先前 261 项测试通过作为性能已达标的依据。
