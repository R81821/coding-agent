# 暂停保留审批：修复与验证

日期：2026-10-22

## 修复后的行为

- 点击“暂停本轮”保留原审批 ID、`pending` 状态和原到期时间。暂停本身不写入拒绝决定，也不延长有效期。
- 暂停解除当前执行栈的等待，使任务保存检查点并停止；待审批操作不会执行，权限不会因此授予。
- 点击“继续”后，在模型或工具执行前重新等待同一审批。暂停期间明确批准可以保存决定，执行仍要等用户继续。
- 旧版计划审批也保留计划 ID、版本和待审批状态；明确决定后界面刷新。恢复与保存计划决定同时发生时，同步内存计划，防止旧状态覆盖新决定。
- 明确拒绝、取消和到期仍按各自语义处理。重复或过时的工具审批提交返回已有决定，不反转决定。

## 原因与修改

后台原暂停路径调用了拒绝审批逻辑，导致审批记录被写成 `denied`、`decidedBy=system:paused`。前端还可能保留旧的待审批快照，随后批准会触发 `Approval ... is already denied`。

`packages/core/src/approvals.ts` 现在将解除等待与决定审批分开，保留原计时器及持久化记录。`packages/core/src/engine.ts` 在检查点保存挂起审批 ID，恢复时重新绑定，真正取消时清理剩余请求。协议增加可选字段，兼容既有检查点。

桌面端弹窗、审批中心、暂停按钮共用同步操作锁，并忽略旧轮询结果。请求失败后显示可重试错误；计划面板在决定保存后主动刷新，暂停时没有新运行事件也能更新状态。后台 RPC 对重复提交返回真实决定，内部严格决定接口仍保留状态校验。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 最终代码定向回归 | 5 个文件、33 项测试通过 |
| 生产 Electron 界面回归 | 36 项断言通过，8 张截图已核对关键状态 |
| TypeScript 类型检查 | 通过 |
| ESLint 全项目检查 | 通过 |
| 桌面端生产构建 | 通过 |
| 后台构建（含恢复竞态修复） | 通过 |
| 最终全量回归 | 231 个文件、2211 项测试全部通过，耗时 278.28 秒 |

定向回归包含 13 项审批代理测试、12 项真实引擎测试、3 项验证发布测试，以及 5 项桌面审批逻辑和组件测试。真实引擎测试覆盖两种现有工作流、计划审批、重复暂停恢复、到期、取消及恢复时立即保存计划决定。

首轮全量运行有 3 项失败：两项验证发布的手写测试夹具没有初始化新增的挂起审批集合，已补齐；另一项恢复窗口用例等待超时，当时引擎仍在更新。最终代码的定向重跑全部通过，完整重跑结果记录在 `full-test.log`；首轮日志保留在 `full-test-initial-failed.log`。

最终完整回归在代码稳定后于 11:06:26 启动，退出码为 0。测试命令为 `pnpm test --maxWorkers=4`。另见 [定向测试日志](targeted-test.log)、[全量测试日志](full-test.log)、[界面测试日志](ui-test.log)、[类型检查日志](typecheck.log)、[规范检查日志](lint.log)、[桌面构建日志](desktop-build.log) 和 [后台构建日志](daemon-build.log)。

界面验证使用实际生产构建的 Electron 渲染器、隔离存储和模拟 IPC；真实文件、持久化、权限及恢复语义由引擎测试验证。截图脚本在 DOM 状态断言后等待绘制完成，防止离屏截图捕获旧帧。

UI 测试命令：

```powershell
pnpm --filter @harness/desktop exec cross-env NODE_OPTIONS= electron scripts/approval-race-ui-test.cjs
```

`ui-test.log` 中 `FIXTURE_APPROVAL_CONNECTION_FAILURE` 和 `FIXTURE_PLAN_CONNECTION_FAILURE` 是故意注入的连接失败，用来检查错误提示及重试。测试要求前端没有未捕获错误。

## 截图与结果

- [暂停后审批仍为 pending](approval-paused-no-stale-dialog.png)
- [继续后同一操作重新等待审批](approval-resumed-same-operation.png)
- [已被其他用户拒绝时同步真实状态](approval-stale-decision-synced.png)
- [工具审批连接失败后可重试](approval-network-error-retry.png)
- [工具审批重试成功](approval-retry-approved.png)
- [暂停中的计划批准后刷新](approval-paused-plan-approved.png)
- [暂停中的计划失败后可重试](approval-paused-plan-error-retry.png)
- [计划重试成功](approval-paused-plan-retry-approved.png)
- [界面断言与 RPC 记录](result.json)

## 加载修复

需要重启本项目桌面端及其后台进程以加载后台修改。本次验证没有修改用户真实审批记录；此前已拒绝或已到期的记录不会自动恢复为待审批。
