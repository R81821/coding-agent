# Harness Agent 高危+中危修复设计

日期：2026-09-02
范围：代码分析发现的 高危 10 类（约 20 项）+ 中危（约 25 项）。低危项不修。
交付：5 个阶段，每阶段独立验证（`pnpm typecheck && pnpm test` 全绿）。每项修复 TDD。
约束：Surgical changes —— 只改与修复直接相关的行；不重构无关代码；匹配现有代码风格。

## 已确认决策

- H1 权限模型按**恢复设计意图**修复：审批通过的 grant 落地生效，tools 层消费 grants。
- 匹配语义：pathGlobs/commandPrefixes/networkDomains 用现有 PermissionEngine.globMatch 语义；`**` 表示全部。
- 空数组语义：PermissionEngine.matches 保持现状（空数组 = 无约束），避免破坏 Profile 级 grants 的现有默认行为；但在 protocol 的 PermissionGrantSchema 注释中明确该语义，并对**审批产生的 grant** 强制要求至少一项约束非空（见 H1c）。

## Phase 1 — 权限闭环与 IPC 面

1. **H1a grant 落地**：`ApprovalBroker.decide(id, approved=true)` 后，engine 把 `approval.requestedGrant` 合并进该 run 的 `spec.grants`，并通过 `database.saveRun` 持久化。同一 run 内后续工具调用走 `spec.grants` 匹配，不再重复审批。
2. **H1b tools 消费 grants**：tools 包增加统一入口 `applyGrants(context, input)`（新文件 `tools/src/grants.ts`）：
   - 路径类输入（read_file/list_files/search_text/apply_patch 的 path 参数）经 `matchesAnyGlob(pathGlobs, path)` 校验（前缀+glob，复用 globMatch 逻辑并处理 Windows 盘符）；
   - terminal 的 command 经 commandPrefixes 前缀匹配；
   - browser 的 navigate url 经 networkDomains 域匹配（hostname 后缀匹配 + IP 字面匹配）；
   - 工具风险级超过 grants 中 maxRisk 且无 grant 覆盖时拒绝。
   - grant 过期（expiresAt）检查。
3. **H1c 空 grant 语义**：PermissionEngine.matches 保持现状（空数组=无约束），但在 protocol PermissionGrantSchema 与 security.ts 注释中明确该语义，并在 engine.authorizeTool 对**审批产生的 grant** 强制要求至少一项约束非空（防"批准一次=完全放开"）。
4. **IPC 白名单**：桌面主进程 `harness:request` 增加 `RENDERER_ALLOWED_METHODS` 白名单（health、run.start、run.resume、run.cancel、run.events、plan.get、plan.decide、approvals.list、approval.decide、tasks.list、tasks.upsert、profiles.list、profiles.upsert、memory.list、memory.decide、skills.list、search.status、trace.query、attachment.put）；`approval.decide`/`plan.decide` 的 actor 由主进程强制注入 `desktop:user`。
5. **daemon socket error**：daemon 对每个连接注册 `error` 监听器与 `close` 清理，客户端断开不影响 daemon。

验收测试（tests/ 新增或扩展）：
- `permissions-grant.test.ts`：同 run 同路径写工具第二次调用不弹审批；越界路径/域名/命令被拒绝；grant 过期后重新审批。
- `ipc-whitelist` 属 Electron 主进程，抽成纯函数 `isAllowedRendererMethod()` 单测 + 手动验证。

## Phase 2 — 加密与持久化健壮性

1. key-envelope 原子写：`crypto.ts` 写信封改为 temp+rename；写前把现有信封复制为 `key-envelope.json.bak`。
2. schema-v2 迁移备份：删除前把 v1 目标移动到 `backup/v1-<ISO时间戳>/`（非 git 迁移不可逆，保留最近 3 份，旧份清理）。
3. sql.js 写放大：`sqlite.ts` flush 去抖（首次调用立即写，后续 500ms 窗口内合并），新增 `flushNow()` 供 close 使用；`close()` 强制 flush。
4. blob-store `read()` 路径校验：resolve 后必须位于 blobs 根之下，否则抛错。
5. 文件锁：database 打开时创建 `harness.sqlite.lock`（内容为 pid+时间），已存在且 pid 存活时进入只读模式（拒绝写操作并抛明确错误）。

验收测试：信封损坏恢复（.bak 回退）、迁移备份存在性、多次 appendEvent 后 export 次数 ≤ 上限、read 路径穿越拒绝、双实例锁冲突。

## Phase 3 — 爆破/穿越/插件信任

1. 配对码：connectors 与 gateway 两处统一为 8 位（字符集 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` 去易混），SHA-256 哈希存储，5 次失败作废，比较用恒定时间函数。
2. skills draft id 校验：`manifest.id` 正则 `^[a-z0-9][a-z0-9._-]{0,63}$`，draft 与 approve 入口拒绝非法 id；protocol SkillManifestSchema.id 同步收紧。
3. 插件 node_modules 纳入哈希：hashDirectory 递归纳入 node_modules（排除 `node_modules/.cache` 等易变目录）。
4. 插件实时验证：tools() 调用时按源目录根做快速指纹（最大 mtime + 文件数），与启用时快照不符则视为失信任。
5. DNS 重绑定：broker net.fetch 用 `dns.lookup` 解析后校验 IP 非私有/环回/链路本地（白名单域名显式含 IP 字面时允许）。
6. docker 加固：`--user node` + `--security-opt no-new-privileges`。
7. 附件下载上限：Telegram 用 file_size 预检、Feishu 流式累计截断，上限 30MB。

验收测试：配对码限次作废、非法 skill id 拒绝、node_modules 篡改后插件工具不可用、内网 URL fetch 拒绝、超大附件拒绝。

## Phase 4 — 预算与 Gateway

1. delegate 预算聚合：子 Run 完成后把 spentUsd/toolCalls/inputTokens 累加进父 ActiveRun，父 checkBudget 生效；子 Run 的 maxUsd 上限保持为父预算/divisor，但父总账不再被绕过。
2. gateway 审计：收到 usage 事件即 upsert 审计行（run 维度唯一键），断连/错误时以已收 usage 结算；无 usage 时用 roughTokenCount 估算。
3. gateway 显式价格：/admin/providers 校验 input/output 单价必填且 > 0；gateway 路由 descriptor 用配置价。
4. /v1/pair 速率限制：内存令牌桶（每 IP 5 次/分钟）+ 失败计数。
5. master key 轮换：密文格式加 `keyVersion` 前缀，支持 `GATEWAY_MASTER_KEY_V2` 新 key 写入、旧 key 解密存量。

验收测试：gateway 首次补测试——pair 限速、预算 429、断连入账、key 轮换解密旧密文、admin 认证。

## Phase 5 — 适配器正确性与桌面端

1. OpenAI Responses：developer 角色映射为 system。
2. Gemini 流式：先写复现测试确认累积重复输出，改为增量 yield（文本长度游标），usage 仅取最后一次。
3. SSE：read() 绑定 signal；done 前 flush buffer。
4. OpenAI-compatible tool_calls：index→buffer Map，缺 index 顺序分配。
5. 防注入前缀统一：OpenAI Responses function_call_output 与 Gemini functionResponse 加与 Anthropic 一致的 "Untrusted tool output..." 前缀。
6. runProcess：超时/abort 时 Windows taskkill /T；ProcessResult 加 timedOut。
7. 桌面 pollRun：send/pollRun 全链路 try/finally 保证 setBusy(false) + 错误 toast。
8. restartDaemon：记录旧 PID，等待 PID 消失（≤3s），超时报错；dev 模式用 taskkill /T 杀进程树。

验收测试：适配器消息转换单测、SSE 边界单测、Gemini 增量测试、runProcess 超时测试；桌面端辅助函数测试 + 手动清单。

## 全局验收

每阶段：`pnpm typecheck` + `pnpm test` 全绿。全部完成后 `pnpm build` 通过。
不修改：低危项、无关代码、README/SECURITY.md 措辞（除数据策略宣称与实现对齐外）。
