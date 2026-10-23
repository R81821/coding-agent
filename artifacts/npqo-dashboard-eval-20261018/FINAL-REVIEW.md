# npqo 仪表盘 coding-agent 实测评估

**综合评分：78/100。页面产物 82/100，执行流程 60/100，按 80% / 20% 加权，77.6 四舍五入。**

这次 Harness Agent 能从空目录交付可运行、有动态数据和真实截图的 React + TypeScript 仪表盘。主要不足是金融显示细节、跨区域数值一致性、手机房间完整性，以及最终验收收尾可靠性。适合继续迭代的演示原型，尚不足以按“全部需求已正确验收”交付。

原始运行日期为 2026-10-18，本轮复核按客户端日期记为 2026-10-19。被测组合是 Harness Agent 1.4.52、openai-compatible/deepseek-flash、Ultra（请求参数 reasoningEffort=max）、Balanced Developer。工作目录 D:\npqo 初始只有 AGENTS.md；参考图作为 untrusted_attachment 发送，日志确认模型请求携带一个图片附件并成功返回。本轮只检查和运行最终产物，未替被测 agent 修复 src 或 scripts。

**重新执行的结果**

| 检查 | 本轮实际结果 | 证明范围 |
|---|---|---|
| npm test | 2 个测试文件、9 项测试通过 | 引擎确定性、部分行情不变量、8 卡、更新、暂停/单步/恢复、hover 基本行为 |
| npm run build | 通过 | TypeScript 严格检查、Vite 生产构建 |
| npm run screenshots | 通过 | 真实 Chrome 的 1440×1000、1024×900、390×844；4/2/1 列；无整页横向溢出；基本交互通过 |
| 独立生产页面检查 | 18 项中 15 项通过、3 项失败 | 动态权益/K线/卡片、暂停、单步、三宽布局及控制台；额外检查复现下列金额和时间对齐问题 |
| 独立 hover 复现 | 确认金额陈旧 | 鼠标不动，tick 0000→0002，十字线 cy 64.28→74.94，tooltip 金额仍为 $71,914.80 |

独立检查使用本轮新构建的生产页面 http://127.0.0.1:4173/ ，未依赖 agent 的成功自述。生产浏览器无未捕获异常、无 console warning/error、无 HTTP 失败。预览服务已启动供复看。

**代码中仍存在的问题，按影响排序**

1. **[P2] 权益成交量与时间轴不对齐。** [EquityPanel.tsx:27](D:/npqo/src/components/EquityPanel.tsx:27) 从仅保留 38 根的 candles 取数据，但 [第 139 行](D:/npqo/src/components/EquityPanel.tsx:139) 按 72 个 balanceSeries 点的 xFor(index) 放置柱子。独立 DOM 读数显示最后一根柱 x=509.32，最新权益点的轴右端为 972，成交量只画到约 52% 位置，最新柱与“NOW”错开 34 个 tick。应按真实 tick/time 对齐，并为历史长度差异保留偏移。

2. **[P2] 统一数据源没有保证 SIZE 的语义一致。** [eventEngine.ts:240](D:/npqo/src/data/eventEngine.ts:240) 计算卡片仓位，而 [PixelRoom.tsx:473](D:/npqo/src/components/PixelRoom.tsx:473) 在组件里用另一套公式重新生成房间金额。本轮同一暂停快照 seq=7 中，卡片为 $3,717，SIZE BAY 为 $3,438。架构确实只有一个市场计时器，但同名业务指标仍然矛盾。应把 positionSize 作为快照字段由两个区域共同消费。

3. **[P2] 悬停金额在行情推进后过期。** [EquityPanel.tsx:60](D:/npqo/src/components/EquityPanel.tsx:60) 把 index/value/day 一起缓存；新快照到来后十字线读取新 series，tooltip 却仍显示 [第 166 行](D:/npqo/src/components/EquityPanel.tsx:166) 的旧 hover.value。本轮已在生产浏览器复现。应保存稳定时间标识，按当前数据派生金额，或明确冻结整套被检查快照。

4. **[P2] 主余额格式错误。** [EquityPanel.tsx:81](D:/npqo/src/components/EquityPanel.tsx:81) 在 `.toFixed(2).slice(1)` 已含小数点的字符串前又补一个点，实际显示 `$73,307..76`。应采用统一的金额格式化，另测进位边界。

5. **响应式验收缺口：390px 的房间被裁切。** [PixelRoom.tsx:385](D:/npqo/src/components/PixelRoom.tsx:385) 的 `xMidYMid slice` 配合移动端固定高容器，裁掉左右陈设、部分角色与图表标签。README 已明确承认这个取舍；它不是整页溢出，但也不是房间内容完整适配。截图测试主动排除 `.room-viewport`/SVG 内部元素，因此“无横向溢出”不能证明场景完整。应提供可发现的平移/缩放，或设计完整的移动端场景。

6. **[P3] 历史 tick 标签会显示为 `0-27`。** [EquityPanel.tsx:165](D:/npqo/src/components/EquityPanel.tsx:165) 对负数直接 padStart，预热历史与 seq 清零的设计也未协调。agent 交付的 verification.json 和本轮 hover 均能复现。应定义预热历史的 tick/time，再正确格式化。

**产物评分明细**

| 维度 | 得分 | 理由 |
|---|---:|---|
| 参考图视觉还原 | 16/20 | 黑底、霓虹粉、8 卡、房间和下方金融区层级保留；空间更平面，外围粉色与原图信息密度存在差距 |
| 8 个 Agent 卡片 | 10/10 | 8 个不同 Agent、不同角色/指标/状态，实际会更新 |
| 动态金融图表 | 12/15 | 权益、K线、量柱、订单簿真实随数据更新；时间轴、hover 和金额格式扣分 |
| 中央像素房间 | 12/15 | 原生 SVG 工位、角色、设备、线缆和大屏完整；透视与细节还原有限，辅助文字偏小 |
| 统一模拟事件源 | 8/10 | MarketEngine + Provider 的单 interval 架构成立，但 SIZE 存在重复业务计算 |
| 三宽响应式 | 10/15 | 1440/1024/390 的 4/2/1 列重排可用；手机房间裁切，细节可读性不足 |
| 实际运行 | 5/5 | 安装、开发运行和本轮生产构建均有真实结果 |
| 实际测试 | 4/5 | 9 测试和浏览器断言有价值，但缺少跨区金额一致性、成交量时序和持续悬停断言 |
| 实际截图交付 | 5/5 | 三宽整页截图、房间细节和悬停态均真实存在且能重新生成 |
| **合计** | **82/100** | |

**Agent 执行流程评分：60/100**

| 维度 | 得分 | 依据 |
|---|---:|---|
| 故障诊断与恢复 | 20/25 | 自行处理工作流证据引用、Windows ENAMETOOLONG、5173 端口占用、tooltip 崩溃及 favicon 404 |
| 工具与环境适配 | 15/20 | 能改用 stdin 写大文件，使用真实本机 Chrome；但后续 provider 输出参数不兼容 |
| 审批与交互负担 | 8/20 | 35 次计划批准，计划常仅显示 Execute terminal；所有审批等待合计约 5 分 33 秒 |
| 验收与收尾 | 7/25 | 构建/测试/截图已实际成功，但原 run 没有成功完成逐项验收和最终报告 |
| 证据可追踪性 | 10/10 | 工具回执、命令输出、截图、README 和可重跑脚本齐全 |
| **合计** | **60/100** | |

原 run 墙钟耗时 **26 分 05 秒**。35 次计划批准都标记为 desktop:user；日志不能独自判断操作者是否为人手点击。本评估只代为批准了明确记录的 v9 计划，没有发补充实现提示或替写仪表盘。累计输入回执约 1622 万 tokens，其中约 1542 万为缓存输入；输出约 16.7 万。费用未知，不能把日志中的 0 美元预算记账当作实际免费。

需要明确：**代码产物已生成，不等于 agent 会话成功收尾。** 所记录 run `run_a566d631-77eb-418e-ac99-c252a35395ef` 最终状态是 failed。最后阶段 workspace diff 不完整使需求验收被拒绝，随后请求 maxOutputTokens=961132，超过 provider 的 393216 上限，返回 HTTP 400。建议优先修复输出 token 上限约束、非 Git 新项目的 diff/验收回退以及重复计划审批，再补齐上面业务一致性和移动端完整性测试。

**截图与可复算证据**

- Agent 交付：[1440px](D:/npqo/screenshots/dashboard-1440.png)、[1024px](D:/npqo/screenshots/dashboard-1024.png)、[390px](D:/npqo/screenshots/dashboard-390.png)、[房间细节](D:/npqo/screenshots/pixel-room-1440.png)、[原验证 JSON](D:/npqo/screenshots/verification.json)。
- 本轮独立截图：[1440px](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/independent-1440.png)、[1024px](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/independent-1024.png)、[390px](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/independent-390.png)。
- 本轮命令日志：[Vitest](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-vitest.log)、[构建](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-build.log)、[三宽浏览器](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-screenshots.log)。
- 独立复现：[浏览器结果](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/independent-browser-results.json)、[hover 结果](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/hover-probe-results.json)、[悬停前](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/hover-before.png)、[悬停后](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/hover-after.png)、[源码 SHA-256 清单](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019/source-manifest.json)。
- 补充审计：[最终代码复核](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-code-audit.md)、[原运行汇总](D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-run-summary.md)、[原 run 失败结果](D:/qweai/artifacts/npqo-dashboard-eval-20261018/agent-final-result.json)。
