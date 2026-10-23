# npqo 最终源码只读复核

复核对象：D:\npqo 当前最终源码、现存测试文件、截图脚本及 screenshots/verification.json。只读检查；本审计员没有修改 npqo、启动服务、执行构建或操作 UI。运行是否成功以主审保存的实际命令回执和浏览器记录为准。本报告不将源码推断称为新的运行实验。

## 结论

React + TypeScript、8 张 Agent 卡片、动态 SVG 金融图表、中央 SVG 像素房间、统一 MarketEngine/Context 定时流均真实实现。此前观察的四项业务/呈现缺陷在最终源码中仍然存在。早期 tooltip 在缺失 clientX 时可能产生 undefined 的问题已经增加有限数检查和兜底；不能再将该早期问题当作最终缺陷。初始化 activity id 的潜在重号不在实际渲染的最近两项中同时出现，故不报告 React 重复 key 错误。

## 可证实缺陷

### 1. [P2] 余额固定显示两个小数点

- 位置：[EquityPanel.tsx:81](D:/npqo/src/components/EquityPanel.tsx:81)。
- 源码为 `.{(snapshot.balance % 1).toFixed(2).slice(1)}`。`toFixed(2)` 产生 `0.76`，`slice(1)` 已产生 `.76`，外层再加一个点得到 `..76`。
- 因而非偶发条件；例如余额 `73307.76` 的可视文本必为 `$73,307..76`。同元素 aria-label 调用 fmtUsd，读屏文本却为正常单点，形成可视与辅助文本不一致。
- 父审此前独立浏览器已记录 `$73,307..76`，最终源码仍为同一表达式。不是 fmtUsd 自身错误，格式化函数单测无法捕获该 JSX 拼接错误。

### 2. [P2] 成交量柱与权益曲线的横轴错开 34 个 tick

- 位置：[EquityPanel.tsx:27](D:/npqo/src/components/EquityPanel.tsx:27)、[EquityPanel.tsx:38](D:/npqo/src/components/EquityPanel.tsx:38)、[EquityPanel.tsx:139](D:/npqo/src/components/EquityPanel.tsx:139)。
- 引擎保留 72 个 equity 点和 38 根 candle，见 [eventEngine.ts:49](D:/npqo/src/data/eventEngine.ts:49) 与 [eventEngine.ts:50](D:/npqo/src/data/eventEngine.ts:50)。预热 84 次使两个窗口在首屏即填满。
- 组件取最新 38 根 candle，绘制却传入 `xFor(index)`，该函数按 72 个权益点计算。因此成交量的 index 0..37 被放到权益横轴的 0..37，而对应的应是最近的 34..71。最新成交量落在约 52% 的横向位置，权益曲线最新点在最右侧。
- 影响不止右半部视觉空白：同一 x 坐标的成交量与权益并非同一时刻，金融图表的时间对齐不可信。父审此前独立截图已观察成交量集中左半，最终源码仍未调整。

### 3. [P2] SIZE 卡片与房间 SIZE BAY 各自计算金额

- 卡片金额源：[eventEngine.ts:240](D:/npqo/src/data/eventEngine.ts:240)，`3510 + round(sin(seq * 0.3) * 240)`，由 [eventEngine.ts:311](D:/npqo/src/data/eventEngine.ts:311) 传入卡片。
- 房间金额源：[PixelRoom.tsx:473](D:/npqo/src/components/PixelRoom.tsx:473)，`3510 + ((seq % 7) - 3) * 24`。
- seq=0 时卡片为 `$3,510`，房间为 `$3,438`；seq=1 时分别为 `$3,581` 和 `$3,462`。该结论由两个最终公式直接确定，与随机种子无关。
- 统一 snapshot/定时器成立，但房间另造同一角色的业务指标，削弱了“统一模拟事件源”的跨区域语义一致性。应共享 position/size 指标，而不是仅共享 seq。

### 4. [P2] 鼠标停留后 tooltip 金额落后于标记和 tick

- 位置：[EquityPanel.tsx:60](D:/npqo/src/components/EquityPanel.tsx:60)、[EquityPanel.tsx:50](D:/npqo/src/components/EquityPanel.tsx:50)、[EquityPanel.tsx:165](D:/npqo/src/components/EquityPanel.tsx:165)、[EquityPanel.tsx:166](D:/npqo/src/components/EquityPanel.tsx:166)。
- 仅 pointermove 时将 `{ index, value, day }` 保存到 hover state。后续自动 tick 更新 snapshot/series，但未刷新 hover.value。
- 十字线和高亮点取新 `geometry.points[hover.index]`，标签的 tick 取新 `snapshot.seq`，金额却始终使用上次 pointermove 保存的旧 `hover.value`。图形、时间标签、金额来自不同时刻。
- 稳定复核方式：在实时图上悬停，保持鼠标不动，等待超过一个 1800ms tick；或保持 hover 后通过外部单步推进再比较。该报告基于 React 数据流可证实，未冒充本审计员的 UI 复现。
- 最终增加的 clientX/索引合法性检查只解决 undefined/NaN 路径，没有解决此状态同步问题。

### 5. [P3] 预热历史 tick 被格式化为 `0-27`

- 位置：[EquityPanel.tsx:165](D:/npqo/src/components/EquityPanel.tsx:165)，以及 [eventEngine.ts:144](D:/npqo/src/data/eventEngine.ts:144) 的预热和下一行 seq 清零。
- 历史点的 `snapshot.seq - (series.length - 1 - hover.index)` 在初始阶段可为负数，`String(-27).padStart(4, '0')` 输出 `0-27`，属于数字符号格式错误。
- 最终交付的 screenshots/verification.json 自身记录 `DAY 11 / TICK 0-27 $71,914.80`。即使允许相对负 tick，也应以合法的 `-027` 或明确历史时间形式展示。

## 响应式的确定事实与限制

- [styles.css:476](D:/npqo/src/styles.css:476)、[styles.css:2053](D:/npqo/src/styles.css:2053)、[styles.css:2266](D:/npqo/src/styles.css:2266) 分别实现 4、2、1 列卡片，其他分析区也有真实重排。
- [PixelRoom.tsx:385](D:/npqo/src/components/PixelRoom.tsx:385) 使用 `xMidYMid slice`；手机在 [styles.css:2330](D:/npqo/src/styles.css:2330) 固定 300px 高。交付记录的 SVG 外框为 368×300，对 1200×600 原场景取中间约 736 个 viewBox 单位，左右各裁约 232 单位。
- 因此 390px 页面不横向溢出，并不代表房间内容完整可见：SIZE BAY、左侧部分工作站、右侧风险机柜被裁。README 已明确承认这是移动端取舍，应该作为响应式完整性限制评价，不应误报成未经说明的崩溃或浏览器溢出。

## 测试覆盖评估

现存 2 个测试文件共 9 个测试：4 个引擎测试与 5 个 React 集成测试。内容有实际价值，不能仅视为数量凑齐。

- [eventEngine.test.ts:5](D:/npqo/src/data/eventEngine.test.ts:5)：同种子初始及连续 tick 可重放；不同种子产生不同 tape。
- [eventEngine.test.ts:25](D:/npqo/src/data/eventEngine.test.ts:25)：检查 8 个不同 id、窗口上限、PNL 与余额、bid/ask 包围价格、OHLC 高低关系、正 volume、进度边界、最新 candle close 等于价格。
- [App.test.tsx:23](D:/npqo/src/App.test.tsx:23)：8 卡名称及 id、图表、房间和阈值存在。
- [App.test.tsx:43](D:/npqo/src/App.test.tsx:43)：timer 推进、首卡数值及权益路径变化。
- [App.test.tsx:68](D:/npqo/src/App.test.tsx:68)：暂停保持、单步推进及恢复。这项 React 测试确实断言精确 tick 0→1→2。
- [App.test.tsx:92](D:/npqo/src/App.test.tsx:92)：pointermove 后 tooltip 存在并有金额，移出后消失。
- [screenshots.mjs:16](D:/npqo/scripts/screenshots.mjs:16)：真实 Chrome 三视口；检查卡数/id/列数、房间外框、K 线/阈值/站点数量、页面横向溢出、console/pageerror，并截图；另验证暂停/推进/恢复和 hover 存在。

缺口：

1. “same snapshot” 测试 [App.test.tsx:118](D:/npqo/src/App.test.tsx:118) 实际只检查 BOOK/ASK/BID 等文本和阈值行存在，没有跨区比较业务值，不能捕获 SIZE 冲突。
2. “drives cards, charts and room” 只对首卡与权益路径验证变化；K 线和房间仅检查元素数，未验证同 tick 的图形值一致。
3. tooltip 测试没有 hover 后继续推进 timer；金额正则不核对对应 tick/曲线值，故漏过陈旧金额与 `0-27`。
4. fmtUsd 测试正确，但没有检查最终余额可视 DOM；也没有对成交量与权益的时间索引对齐断言。
5. 浏览器元素溢出检测在 [screenshots.mjs:76](D:/npqo/scripts/screenshots.mjs:76) 排除整个房间和全部 SVG，且只验证房间外框，不能证明手机房间内部完整；自动视觉比较和人工视觉质量需另行判断。
6. 浏览器脚本 [screenshots.mjs:176](D:/npqo/scripts/screenshots.mjs:176) 的“exactly one”实为 `steppedTick > heldTick`，可接受多步；React 集成测试补有精确断言，故这是浏览器验证粒度不足，而非已证明 STEP 实现错误。

## 对评分的建议

代码证据支持 8 卡功能满分或接近满分；统一源架构真实可给高分，但建议因 SIZE 语义冲突扣 1–2 分（10 分项约 8 分）。动态金融图表持续更新成立，成交量错轴、陈旧 hover 和余额文本错误应实质扣分（15 分项约 11–12 分）。实际测试有有效数据不变量、交互和三宽浏览器验证，可给 4/5 左右；不应因为 9/9 通过就称上述业务正确性全覆盖。整体总分仍需主审结合最终视觉截图、真实运行回执与原题完整量表确定，避免对未亲自观察的部分伪造精确分数。
