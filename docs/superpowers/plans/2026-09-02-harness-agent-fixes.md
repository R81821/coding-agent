# Harness Agent 高危+中危修复实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码分析发现的全部高危与中危问题（约 45 项），每阶段独立验证。

**Architecture:** 5 个阶段按风险主题划分：①权限闭环+IPC 面 ②加密与持久化健壮性 ③爆破/穿越/插件信任 ④预算与 Gateway ⑤适配器正确性与桌面端。每项修复 TDD（先写失败测试）。

**Tech Stack:** TypeScript strict、pnpm monorepo、vitest、zod、Electron、sql.js、Fastify。

**注意：** 本目录不是 git 仓库，无 commit 步骤；每任务以 `pnpm typecheck` + 对应测试通过为完成标志。

**Spec:** `docs/superpowers/specs/2026-09-02-harness-agent-fixes-design.md`

---

## Phase 1 — 权限闭环与 IPC 面（本阶段任务已完整展开）

### Task 1.1: tools 层消费 grants（新建 grants.ts + builtins 接线）

**Files:**
- Create: `packages/tools/src/grants.ts`
- Modify: `packages/tools/src/builtins.ts`（terminalTool.execute、browserTool.execute）
- Modify: `packages/tools/src/index.ts`（导出 grants.ts）
- Test: `tests/permissions-grant.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/permissions-grant.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { grantsAllow } from "@harness/tools";
import type { PermissionGrant } from "@harness/protocol";

function grant(partial: Partial<PermissionGrant>): PermissionGrant {
  return {
    toolNames: ["terminal"],
    pathGlobs: [],
    commandPrefixes: [],
    networkDomains: [],
    maxRisk: "high",
    ...partial,
  };
}

describe("grantsAllow (tools-layer grant enforcement)", () => {
  it("allows a command covered by an active grant prefix", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"] })], { command: "npm test -- --coverage" }, "high");
    expect(reason).toBeUndefined();
  });

  it("rejects a command outside every grant prefix", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"] })], { command: "git push" }, "high");
    expect(reason).toContain("No active grant covers");
  });

  it("allows a browser URL inside a granted domain", () => {
    const reason = grantsAllow("browser", [grant({ toolNames: ["browser"], networkDomains: ["example.com"] })], { url: "https://api.example.com/x" }, "high");
    expect(reason).toBeUndefined();
  });

  it("rejects a browser URL outside every granted domain", () => {
    const reason = grantsAllow("browser", [grant({ toolNames: ["browser"], networkDomains: ["example.com"] })], { url: "https://evil.example.com.attacker.io/" }, "high");
    expect(reason).toContain("No active grant covers");
  });

  it("ignores expired grants", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"], expiresAt: new Date(Date.now() - 1_000).toISOString() })], { command: "npm test" }, "high");
    expect(reason).toBeUndefined();
  });

  it("does not constrain tools without matching grant entries", () => {
    const reason = grantsAllow("terminal", [], { command: "anything" }, "high");
    expect(reason).toBeUndefined();
  });

  it("never constrains read-risk calls", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["other"] })], { command: "npm test" }, "read");
    expect(reason).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/permissions-grant.test.ts`
Expected: FAIL（`@harness/tools` 未导出 `grantsAllow`）

- [ ] **Step 3: 实现 grants.ts**

```ts
import type { PermissionGrant, RiskLevel } from "@harness/protocol";

const riskRank: Record<RiskLevel, number> = { read: 0, write: 1, high: 2, destructive: 3 };

/**
 * Tools-layer half of the permission model: the engine decides which calls are
 * authorized, and tools verify that the call stays inside the granted scope.
 * Returns undefined when the call is allowed, otherwise a human-readable reason.
 * Tools with no matching grant entry are unaffected (the engine remains the gate;
 * an empty grants array — e.g. the default profile — applies no scope limits here).
 */
export function grantsAllow(
  toolName: string,
  grants: PermissionGrant[],
  input: Record<string, unknown>,
  risk: RiskLevel,
): string | undefined {
  if (risk === "read") return undefined;
  const now = Date.now();
  const relevant = grants.filter(
    (grant) =>
      (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now) &&
      grant.toolNames.includes(toolName) &&
      riskRank[risk] <= riskRank[grant.maxRisk],
  );
  if (relevant.length === 0) return undefined;
  const command = typeof input.command === "string" ? input.command.trim() : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  for (const grant of relevant) {
    if (command !== undefined && grant.commandPrefixes.length > 0 && !grant.commandPrefixes.some((prefix) => command.startsWith(prefix))) continue;
    if (url !== undefined && grant.networkDomains.length > 0) {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (!grant.networkDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    }
    return undefined;
  }
  return `No active grant covers ${toolName} with the requested scope`;
}
```

- [ ] **Step 4: 接线 builtins.ts**

`terminalTool.execute` 在 `const parsed = terminalInput.parse(input);` 之后、`runProcess` 之前插入：

```ts
    const risk = terminalTool.assessRisk?.(parsed) ?? terminalTool.contract.risk;
    const denied = grantsAllow("terminal", context.grants, parsed, risk);
    if (denied) throw new Error(denied);
```

`browserTool.execute` 在 `const parsed = browserInput.parse(input);` 之后插入：

```ts
    const risk = browserTool.assessRisk?.(parsed) ?? browserTool.contract.risk;
    const denied = grantsAllow("browser", context.grants, parsed, risk);
    if (denied) throw new Error(denied);
```

builtins.ts 顶部加 import：`import { grantsAllow } from "./grants.js";`
index.ts 加导出：`export * from "./grants.js";`

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/permissions-grant.test.ts`
Expected: 7 tests PASS

### Task 1.2: 审批通过的 grant 落地并持久化（engine.ts）

**Files:**
- Modify: `packages/core/src/engine.ts`（authorizeTool 内 decision 通过分支）
- Test: `tests/engine-grant.test.ts`

- [ ] **Step 1: 阅读测试基建**

读 `tests/engine.test.ts` 前 120 行，复用其 fake provider / runtime 构建方式（真实 SQLite+Vault，模拟 provider）。新的集成测试断言：一个 grant 为空的 run，模型连续发出两次相同命令的 terminal 调用，用户批准第一个审批后，**第二个调用不产生第二条 approval_required 事件**（grant 生效）。

- [ ] **Step 2: 写失败测试**

`tests/engine-grant.test.ts`（结构与 engine.test.ts 一致，fake provider 第一次返回两个相同 terminal tool_call 的轮次）：

```ts
import { describe, expect, it } from "vitest";
// 复用 tests/engine.test.ts 的 helper（按 Step 1 确认的实际导出名调整 import）
import { /* fakeProvider, runtime 构建 helpers */ } from "./helpers/engine.js";

describe("approval grants are persisted and reused within a run", () => {
  it("approves once and does not re-request approval for an identical covered call", async () => {
    // provider 第一次响应产出两个内容相同的 terminal tool_call
    // 等待 approval_required 事件 -> engine.approvals.decide(id, true, "test")
    // 断言：事件流中 approval_required 只出现 1 次；run 最终 completed
    const events: AgentEvent[] = [];
    // ...（事件收集与断言逻辑，helpers 就绪后补全）
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
  });
});
```

（若 engine.test.ts 无共享 helper，则在本文件内复制其最小构建代码，不创建共享文件。）

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run tests/engine-grant.test.ts`
Expected: FAIL（approval_required 出现 2 次）

- [ ] **Step 4: 实现 grant 落地**

`engine.ts` authorizeTool 中，把：

```ts
      if (!(await decision)) {
        this.status(spec.id, state, "running");
        return {
          block: true,
          reason: "Tool execution denied or approval expired",
        };
      }
      this.status(spec.id, state, "running");
```

改为：

```ts
      if (!(await decision)) {
        this.status(spec.id, state, "running");
        return {
          block: true,
          reason: "Tool execution denied or approval expired",
        };
      }
      spec.grants = [...spec.grants, requestedGrant];
      this.deps.database.saveRun(spec, state.status);
      this.saveCheckpoint(spec.id, state, "manual");
      this.status(spec.id, state, "running");
```

说明：`saveRun` upsert 整个 RunSpec（`database.ts:65-69`），grants 随 run 记录持久化；resume 从 DB 读取 `stored.spec` 恢复 grants。`getPinnedContext`（engine.ts:322）已引用 `spec.grants`，无需改动。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/engine-grant.test.ts`
Expected: PASS

### Task 1.3: 桌面端 IPC 方法白名单 + actor 强制

**Files:**
- Create: `apps/desktop/src/renderer-ipc.ts`
- Modify: `apps/desktop/src/main.ts:158-162`（harness:request handler）
- Test: `tests/renderer-ipc.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/renderer-ipc.test.ts`（相对导入 `../apps/desktop/src/renderer-ipc.js`，该模块纯函数、不依赖 electron）:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

describe("sanitizeRendererRequest", () => {
  it("allows whitelisted methods", () => {
    expect(sanitizeRendererRequest("run.start", { id: "r1" }).method).toBe("run.start");
  });

  it("rejects non-whitelisted methods", () => {
    expect(() => sanitizeRendererRequest("trace.export", {})).toThrow("cannot invoke");
  });

  it("forces the actor to desktop:user on approval.decide", () => {
    const result = sanitizeRendererRequest("approval.decide", { approvalId: "a1", approved: true, actor: "attacker" });
    expect(result.params).toEqual({ approvalId: "a1", approved: true, actor: "desktop:user" });
  });

  it("forces the actor to desktop:user on plan.decide and keeps feedback", () => {
    const result = sanitizeRendererRequest("plan.decide", { planId: "p1", version: 1, approved: false, actor: "attacker", feedback: "revise" });
    expect(result.params).toMatchObject({ actor: "desktop:user", feedback: "revise" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/renderer-ipc.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 renderer-ipc.ts**

```ts
import type { DaemonRequest } from "@harness/protocol";

/** Daemon methods the renderer may invoke. Anything else is rejected at the IPC boundary. */
const RENDERER_ALLOWED_METHODS: ReadonlySet<DaemonRequest["method"]> = new Set([
  "health",
  "run.start",
  "run.resume",
  "run.cancel",
  "run.events",
  "plan.get",
  "plan.decide",
  "checkpoints.get",
  "approvals.list",
  "approval.decide",
  "tasks.list",
  "tasks.upsert",
  "profiles.list",
  "memory.list",
  "memory.decide",
  "skills.list",
  "skills.trust",
  "skills.untrust",
  "plugins.list",
  "plugins.install",
  "plugins.trust",
  "plugins.enable",
  "plugins.disable",
  "search.status",
  "trace.query",
  "project.inspect",
  "project.trust",
  "connectors.pairing",
  "attachment.put",
]);

/**
 * Validate a renderer-originated daemon request: restrict the method set and
 * force the actor on approval decisions so the UI cannot impersonate another actor.
 */
export function sanitizeRendererRequest(
  method: string,
  params: unknown,
): { method: DaemonRequest["method"]; params: unknown } {
  if (!RENDERER_ALLOWED_METHODS.has(method as DaemonRequest["method"])) {
    throw new Error(`Renderer cannot invoke daemon method: ${method}`);
  }
  if (method === "approval.decide" || method === "plan.decide") {
    return {
      method: method as DaemonRequest["method"],
      params: { ...(params as Record<string, unknown>), actor: "desktop:user" },
    };
  }
  return { method: method as DaemonRequest["method"], params };
}
```

- [ ] **Step 4: 接线 main.ts**

把 `apps/desktop/src/main.ts:158-162` 改为：

```ts
ipcMain.handle(
  "harness:request",
  async (_event, request: Omit<DaemonRequest, "id">) => {
    if (!request || typeof request.method !== "string")
      throw new Error("无效的 daemon 请求");
    const sanitized = sanitizeRendererRequest(request.method, request.params);
    return daemonRequest({
      ...request,
      id: newId("request"),
      method: sanitized.method,
      params: sanitized.params,
    } as DaemonRequest);
  },
);
```

main.ts 顶部加 import：`import { sanitizeRendererRequest } from "./renderer-ipc.js";`

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/renderer-ipc.test.ts`
Expected: 4 tests PASS

### Task 1.4: daemon socket error 监听器

**Files:**
- Modify: `apps/daemon/src/main.ts:51-62`（handleSocket）

- [ ] **Step 1: 修改**

```ts
function handleSocket(socket: Socket): void {
  socket.on("error", (error: Error) => {
    process.stderr.write(`Client connection error: ${error.message}\n`);
  });
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      void dispatchLine(line).then((response) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck`（daemon 无测试基建，客户端断开场景按手动清单：dev:daemon 后运行 `pnpm dev:cli doctor` 并 Ctrl+C 中断 CLI，daemon 进程保持存活）

### Task 1.5: 权限语义注释（protocol + security.ts）

**Files:**
- Modify: `packages/protocol/src/index.ts:374-381`（PermissionGrantSchema）
- Modify: `packages/core/src/security.ts:22-36`（matches 方法）

- [ ] **Step 1: 加注释**

protocol PermissionGrantSchema 上方加：

```ts
/**
 * Scoped allowance granted by a user approval or configured in a Profile/RunSpec.
 * Semantics: empty `toolNames` matches no tool; empty `pathGlobs`/`commandPrefixes`/
 * `networkDomains` mean "no constraint on that dimension"; `"**"` in pathGlobs matches
 * all paths. Expired grants (expiresAt in the past) never match.
 */
```

security.ts `matches` 方法上方加：

```ts
  // Empty constraint arrays mean "no constraint on that dimension"; "**" matches all paths.
  // Approval-generated grants (engine.authorizeTool) always carry a concrete scope.
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck`
Expected: 无错误

### Phase 1 收尾验证

- [ ] Run: `pnpm typecheck && pnpm test`
Expected: 全部通过（含新增 3 个测试文件）

---

## Phase 2 — 加密与持久化健壮性（任务大纲，启动本阶段时展开完整代码）

1. key-envelope 原子写 + `.bak` 副本（`packages/persistence/src/crypto.ts:17-55`）— 测试：信封损坏后回退 .bak 恢复
2. schema-v2 迁移备份（`packages/persistence/src/schema-v2.ts:16-44`）— 测试：迁移后 backup/ 目录含旧数据
3. sql.js flush 去抖（`packages/persistence/src/sqlite.ts:35-39`）— 测试：N 次写触发 ≤2 次 export
4. blob-store read 路径包含校验（`packages/persistence/src/blob-store.ts:47-50`）— 测试：穿越路径被拒
5. 文件锁（`packages/persistence/src/sqlite.ts` 打开逻辑）— 测试：双实例第二实例拒绝写

## Phase 3 — 爆破/穿越/插件信任（任务大纲）

1. 配对码熵+限次+恒时比较（`packages/extensions/src/connectors.ts:25-37` + `apps/gateway/src/store.ts:33-54`）
2. skills draft id 校验（`packages/extensions/src/skills.ts:63-92` + protocol SkillManifestSchema.id）
3. 插件 node_modules 纳入哈希（`packages/extensions/src/plugins.ts:119`）
4. 插件启用后实时指纹验证（`packages/extensions/src/plugins.ts:72-78`）
5. DNS 重绑定防护（`packages/extensions/src/plugins.ts:105-110`）
6. docker `--user node` + no-new-privileges（`packages/extensions/src/plugins.ts:92`）
7. 附件下载大小上限（`packages/extensions/src/connectors.ts:83-90,134-144`）

## Phase 4 — 预算与 Gateway（任务大纲）

1. delegate 子 Run 预算聚合（`packages/core/src/runtime.ts:113-143` + engine.ts）
2. gateway 断连/中断入账（`apps/gateway/src/main.ts:60-117`）
3. gateway 显式价格校验（`apps/gateway/src/main.ts:25-38`）
4. /v1/pair 速率限制（`apps/gateway/src/main.ts:48-51`）
5. master key 轮换信封（`apps/gateway/src/store.ts:99-112`）
6. gateway 首批测试（tests/gateway/*）

## Phase 5 — 适配器正确性与桌面端（任务大纲）

1. OpenAI developer 角色映射（`packages/providers/src/adapters.ts:81`）
2. Gemini 流式增量（`packages/providers/src/adapters.ts:213-228`）
3. SSE abort + 尾 buffer（`packages/providers/src/http.ts:11-31`）
4. OpenAI-compatible tool_calls index（`packages/providers/src/adapters.ts:265`）
5. 防注入前缀统一（`packages/providers/src/adapters.ts:79,194`）
6. runProcess 进程树清理 + timedOut（`packages/tools/src/process.ts:10-51`）
7. 桌面 pollRun try/finally（`apps/desktop/src/renderer.tsx:218-287`）
8. restartDaemon PID 校验 + dev 模式杀进程树（`apps/desktop/src/main.ts:376-434`）

## 全局验收

- [x] `pnpm typecheck` 通过
- [x] `pnpm test` 全绿（72/72，新增 34 项测试：permissions-grant 7、engine-grant 1、renderer-ipc 4、persistence-hardening 5、phase3-hardening 5、engine-budget 2、gateway-store 5、provider-fixes 5）
- [x] `pnpm build` 通过（corepack pnpm -r --if-present build）
- [x] `pnpm lint` 通过

**执行状态（2026-09-02）：全部 5 阶段完成。** 与大纲的偏差：
- Phase 2 计划中的"技能信任哈希持久化"（M13）未修——依赖上层拼装为现状，低优先级；
- Phase 3 同时完成了 Phase 4 的 /v1/pair 速率限制（同处编辑）；
- 技能 id 校验仅加在 draft/approve 入口（协议 schema 未收紧，避免破坏存量技能）；
- 桌面端 daemon socket error、restartDaemon PID、dev 模式杀进程树、pollRun 卡死修复需按手动清单验证（Electron 无自动化基建）。
