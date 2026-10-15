# 对话任务队列：性能与交互验证记录

- 日期：2026-10-15
- 仓库：`D:/qweai`
- 环境：Windows，本地 Node/Vitest，原生 Electron 41.10.6。
- 本文记录本次实现过程中实际执行的隔离 fixture。最终全量回归以主计划的交付记录为准。

## 1. 持续任务调度的实测

命令：

```powershell
pnpm exec vitest run tests/conversation-task-performance.test.ts --disableConsoleIntercept --reporter verbose
```

实际结果：1 个测试通过。相同 8 个独立读取任务，每项调用一次固定响应的 fake provider，并等待 25 ms；其中第 7 项固定失败。输入、响应和失败条件在两次运行中一致。

| 指标 | 串行，限制 1 | 并行，限制 4 |
| --- | ---: | ---: |
| 调度至所有任务收尾的墙钟耗时 | 255.16 ms | 61.35 ms |
| 实测执行峰值 | 1 | 4 |
| fake provider 请求数 | 8 | 8 |
| 固定输入 token | 256 | 256 |
| 固定输出 token | 120 | 120 |
| 总 token | 376 | 376 |
| 固定失败数 | 1 | 1 |
| 固定失败比例 | 12.5% | 12.5% |

耗时只输出为观察数据，不作为正确性断言。测试断言峰值并发，以及请求数、输入、输出和失败结果一致。失败比例来自刻意注入的一次失败，不能用于推断模型可靠性。

此 fixture 直接使用内存中的队列记录和真实 `ConversationTaskScheduler`，没有加入 SQLite 加密、Git worktree、补丁集成、真实模型或网络延迟。它测量调度吞吐，不能代表完整用户任务的端到端收益，也不承诺固定加速倍数。

## 2. 同一模型请求内的工具并发

命令：

```powershell
pnpm exec vitest run tests/tool-concurrency.test.ts
```

实际结果：15 个测试通过。性能测试名称为 `records the same fake workload with serial and bounded read execution`。

fixture 使用支持视觉、工具和 parallel tools 的 fake provider。第一轮返回 3 个 workspace 读取工具调用 `a`、`b`、`c`；每个工具的真实实现显式声明只读、幂等，并等待 40 ms。第二轮返回固定文本 `done`。每轮固定返回输入 100、输出 10 token 和 0 美元消耗。

| 指标 | 工具并发限制 1 | 工具并发限制 2 |
| --- | ---: | ---: |
| 耗时 | 159.53 ms | 95.56 ms |
| 实测工具峰值 | 1 | 2 |
| 模型请求数 | 2 | 2 |
| 总输入 token | 200 | 200 |
| 总输出 token | 20 | 20 |
| 失败数 | 0 | 0 |

请求数、用量和执行峰值有断言；耗时只记录。其他 gate/barrier 测试直接证明执行重叠和独占互斥，不通过脆弱的耗时阈值判断并发正确性。

没有单文件 identity 的 workspace 搜索需要在执行前后扫描并计算 workspace 快照。大仓库中的扫描成本可能主导耗时，仍需使用实际仓库和工作负载测量。

## 3. 调度行为的确定性证明

命令：

```powershell
pnpm exec vitest run tests/conversation-task-scheduler.test.ts
```

实际结果：17 个测试通过。测试使用可控制的 gate 和内存记录，验证：

- A、B 同时启动；B 释放后，新加入的 C 在 A 尚未结束时补位。
- 依赖 A 的 D 不因 A 执行完成而启动；只有外部真实验证条件满足后才启动。
- 按优先级、关键路径和稳定创建/持久入队顺序选取下一项；重复 notify 不重复启动尚在启动边界的同一任务。
- 共享工作区写操作互斥；Windows 大小写和目录范围重叠互斥；未知隔离写范围保持保守。
- 不同隔离写范围允许重叠；共享资源键交集仍串行。
- 单项失败释放槽位，无关任务继续。
- 暂停覆盖选择前、执行 microtask 前和任务收尾后补位等边界；等待者及时被唤醒。
- 指定任务集合的等待不会被无关完成唤醒；快照与订阅之间的进展不会丢失；等待取消不取消已运行的子任务。

这些测试证明调度边界，不替代持久层、权限、预算和真实子执行器的集成回归。

## 4. 生产 renderer 的实际交互

先执行：

```powershell
pnpm --filter @harness/desktop build
```

实际构建通过；输出包含 Zod 第三方纯注释和大于 500 kB chunk 的构建警告。

再使用隔离数据和 fake IPC 启动生产 renderer：

```powershell
Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item -LiteralPath Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$queueUiProcess = Start-Process -FilePath 'D:/qweai/apps/desktop/node_modules/electron/dist/electron.exe' -ArgumentList 'D:/qweai/apps/desktop/scripts/conversation-task-queue-ui-test.cjs' -PassThru -WindowStyle Hidden -RedirectStandardOutput 'D:/qweai/.cache/queue-ui-output.log' -RedirectStandardError 'D:/qweai/.cache/queue-ui-error.log'
$queueUiProcess.WaitForExit()
Get-Content -LiteralPath 'D:/qweai/.cache/queue-ui-output.log'
Get-Content -LiteralPath 'D:/qweai/.cache/queue-ui-error.log'
```

实际退出码 0，最终 19 个交互检查通过。覆盖任务状态、等待和失败原因、待集成补丁、完整身份的等待项取消、必填原因的失败项重试、暂停父任务的明确拒绝、切换对话、刷新恢复、迟到响应丢弃和有界队列末项按钮可达性。原子认领但尚未开始子执行的 running 记录显示“准备资源”，保持原 executionState，并将该槽位计为已占用；此项另有组件测试。继续保持一个 human 气泡、一个输入框、一条主上下文占用条，不增加子任务用户会话。预期的暂停重试拒绝会出现在 fixture IPC 的 stderr，随后由测试确认界面展示该原因。

最终交互产物位于 `.cache/conversation-task-queue-ui-fviYDW/result.json` 和 `queue.png`；较早同布局截图 `.cache/conversation-task-queue-ui-jFxMN5/queue.png` 已目视检查。`.cache` 是临时证据目录，不纳入源码交付。

原有 `apps/desktop/scripts/run-steering-ui-test.cjs` 也在同一生产构建上通过，覆盖暂停补充、继续、重复提交、迟到结果、撤回悬停图标、刷新恢复等操作。该脚本仍保持 12 次 steering 请求、0 次新 run、0 次额外 resume。其隔离证据目录为 `.cache/run-steering-ui-uWIdcx`。

`apps/desktop/scripts/model-reasoning-ui-test.cjs` 首次运行失败。补充 renderer 错误记录后，定位为旧 fixture 对 `mcp.interactions.list` 默认返回数组，遗漏真实 RPC 的 `{ requests: [] }` 外壳，导致 MCP 面板读取 `requests.find` 失败。修正 fixture 响应后独立重跑通过全部 47 个交互检查，包括模型 ID、推理等级、动画、键盘焦点、紧凑窗口、保存失败、迟到响应和输入布局。最终产物目录为 `.cache/model-reasoning-ui-l9sMxf`。此修复没有修改模型选择产品逻辑。stderr 中的 `trace.export` 拒绝和 `fixture save rejected` 是脚本刻意触发并验证的失败分支。

## 5. Electron 断日志管道修复

本次验证发现桌面进程可能在启动终端关闭后继续向 stdout/stderr 输出。Node 的 `process.emitWarning` 经 `console.error` 写入断管时，Electron 会因未处理的 EPIPE 弹出主进程异常。入口现在在启动日志前安装仅针对 `EPIPE` 和 `ERR_STREAM_DESTROYED` 的流保护；其他异常继续抛出。

命令：

```powershell
pnpm exec vitest run tests/desktop-output-pipe.test.ts --reporter verbose
```

实际结果：7 个测试通过，包括真实 Node 子进程和原生 Electron 主进程。父端关闭两条输出管道后，子进程继续执行 `console.log`、`console.warn`、`process.emitWarning` 和后续 direct writes，仍能发送存活回执并正常退出。测试同时确认 `EIO`、`EACCES` 等其他错误不会被吞掉，健康输出和回调保持可用。

启动隔离 Electron 检查时使用隐藏进程、重定向日志并等待结束，避免测试进程自身遗留断开的工具输出管道。

## 6. 边界与未测部分

- 所有性能记录使用 fake provider，没有付费模型调用、真实外部服务或用户项目变更。
- 计时没有覆盖模型响应波动、实际 Git 集成、审批等待、真实服务限流或大仓库快照成本。
- synthetic provider 的 token 是固定 fixture 用量，不能作为真实模型成本预测。
- 正确性基于 gate/barrier、状态和收尾断言；性能不通过预设倍数验收。
- 最终统一验收已通过：192 个测试文件、1779 项测试，完整类型检查、lint、daemon/desktop 构建和 diff 检查。实际命令、日志与早期失败修复见主计划第 9 节。
