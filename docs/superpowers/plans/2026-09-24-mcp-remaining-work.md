# MCP 剩余工作实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复委派子任务的 MCP 能力继承缺陷、接线只读判定、让任务级 MCP/技能能力在桌面可见，并补齐原计划剩余验收与接入指南。

**Architecture:** 协议层新增 `mcpInherited` 与两个事件字段；核心层在 `prepareMcpCapabilities` 内区分"恢复冻结"（`prior`）与"父任务上限"（`inherited`）两条收窄路径，只读判定仅由委派子任务触发；引擎在 `tool_started` 上附带来源、并发射一次 `capabilities_resolved`；桌面端据此渲染来源与诊断。

**Tech Stack:** TypeScript、Zod、Vitest、React、Electron、MCP 官方 TypeScript SDK 1.30.0。

**Spec:** `docs/superpowers/specs/2026-09-24-mcp-remaining-work-design.md`

## Global Constraints

- 既有 44 项 MCP 测试必须零回归（store 12、client 9、service 6、oauth 2、rpc 3、runtime 9、skill-integration 3）。
- 每步先用有实际行为断言的测试复现缺失，再实现；不写只验证"函数存在"的空洞测试。
- 不重写现有 UI、评审或预算功能。
- 不改动 `ToolCallSchema`（它进检查点和 provider 类型）。
- analysis 模式**不**硬过滤 MCP 写工具，审批门已覆盖该要求。
- 行号引用基于 HEAD `65ec093` 的工作区状态，实现时以符号名为准。
- **提交策略：全部任务完成后一次性提交工作区全部更改**（用户 2026-09-24 指令，覆盖原计划的"不纳入其他工作区修改"）。因此本计划各任务**不单独提交**，最后一并落库。

## 文件边界

| 文件 | 职责 | 本计划改动 |
| --- | --- | --- |
| `packages/protocol/src/index.ts` | 运行与事件类型 | `RunSpec.mcpInherited`、`ToolCallOriginSchema`、`tool_started.origin`、`capabilities_resolved` 事件 |
| `packages/core/src/mcp-capabilities.ts` | 运行能力租约 | 只读判定接线、`inherited` 上限、长度校验修复 |
| `packages/core/src/engine.ts` | 引擎 | 传 `options.inherited`、`tool_started` 附 origin、发射 `capabilities_resolved` |
| `packages/core/src/runtime.ts` | 运行时装配与委派 | 子 RunSpec 设 `mcpReadOnly` / `mcpInherited` |
| `apps/desktop/src/tool-summary.ts` | 工具摘要 | 识别 origin，显示服务来源 |
| `apps/desktop/src/renderer.tsx` | 会话渲染 | `ToolEventRow` 显示来源徽标与耗时 |
| `tests/mcp-runtime.test.ts` | 运行能力测试 | 新增用例 |

---

### Task 1: 接线只读判定并修复长度校验误报

`spec.mcpReadOnly` 目前是死代码（`mcp-capabilities.ts:64` 检查，全仓库无人设置）。直接接线会立刻触发 `mcp-capabilities.ts:116` 的长度校验误报，所以两者必须同一任务内完成。

**Files:**
- Modify: `packages/core/src/mcp-capabilities.ts`
- Test: `tests/mcp-runtime.test.ts`

**Interfaces:**
- Consumes: 既有 `prepareMcpCapabilities(service, spec, signal, options)`，`RunSpec.mcpReadOnly`
- Produces: 无新导出；`spec.mcpReadOnly === true` 时租约只含 `risk === "read"` 的工具

- [ ] **Step 1: 写失败测试**

追加到 `tests/mcp-runtime.test.ts` 末尾：

```ts
test("a read-only run exposes only read tools", async () => {
  const f = await fixture();
  f.spec.mcpReadOnly = true;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
    expect(lease.tools.every(tool => tool.contract.risk === "read")).toBe(true);
    expect(lease.snapshot).toHaveLength(1);
  } finally { await lease.close(); }
});

test("read-only narrowing on recovery is not misreported as a catalog change", async () => {
  const f = await fixture();
  const first = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  expect(first.snapshot).toHaveLength(4);
  f.spec.mcpSnapshot = first.snapshot;
  await first.close();
  f.spec.mcpReadOnly = true;
  const lease = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
  } finally { await lease.close(); }
});
```

- [ ] **Step 2: 运行测试确认第一条失败、第二条报"目录变化"**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts -t "read-only"
```

预期：**第一条 PASS、第二条 FAIL** 且错误信息匹配 `/MCP tool catalog changed/`。

（修正：初版计划预测第一条也会 FAIL，理由是"过滤分支是死的"。该理由不成立——旧 line 64 写的本来就是 `if (spec.mcpReadOnly && risk !== "read") continue;`，测试自己设了 `spec.mcpReadOnly = true`，分支在测试内是活的。"死代码"只成立于生产路径：无人设置该字段。因此第一条是**回归守卫**而非 RED 用例，真正的 RED 是第二条。实测确认：1 failed, 1 passed。）

- [ ] **Step 3: 实现**

在 `packages/core/src/mcp-capabilities.ts` 的 `prepareMcpCapabilities` 内，`const prior = spec.mcpSnapshot;` 之后加入只读标志：

```ts
  const prior = spec.mcpSnapshot;
  // Analysis-mode runs keep write tools in the catalog and rely on the approval gate;
  // only a read-only delegated child narrows the catalog itself.
  const readOnly = spec.mcpReadOnly === true;
```

把 line 64 的 `<existing>if (spec.mcpReadOnly && risk !== "read") continue;</existing>` 改为：

```ts
          if (readOnly && risk !== "read") continue;
```

把 line 116 的长度校验改为：

```ts
    // Read-only narrowing is an intentional reduction and must not read as catalog drift.
    const eligible = prior?.filter(tool => !readOnly || tool.risk === "read");
    if (eligible && eligible.length !== snapshot.length) throw new Error("MCP tool catalog changed since this run started");
```

用 `<existing>` 包住的那一行表示"文件里现有的这一行"，按内容匹配替换，不按行号。

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts
```

预期：11 项全部 PASS（原 9 项 + 新增 2 项）。

---

### Task 2: 委派子任务继承父任务能力上限

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/mcp-capabilities.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/runtime.ts`
- Test: `tests/mcp-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readOnly`、既有 `spec.mcpSnapshot`
- Produces: `RunSpec.mcpInherited?: McpToolSnapshot[]`；`prepareMcpCapabilities(...options.inherited?: McpToolSnapshot[])`

- [ ] **Step 1: 写失败测试**

追加到 `tests/mcp-runtime.test.ts`：

```ts
test("a delegated child inherits its parent catalog and cannot widen it", async () => {
  const f = await fixture();
  const second = await f.mcp.save({ ...f.server, id: undefined, expectedRevision: undefined, name: "Another service" });
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  expect(parent.snapshot).toHaveLength(8);
  const inherited = parent.snapshot.filter(tool => tool.serverId === second.id);
  await parent.close();
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.snapshot).toHaveLength(4);
    expect(lease.snapshot.every(tool => tool.serverId === second.id)).toBe(true);
  } finally { await lease.close(); }
});

test("a read-only child cannot receive write tools even when its parent had them", async () => {
  const f = await fixture();
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const inherited = parent.snapshot;
  expect(inherited.some(tool => tool.risk === "high")).toBe(true);
  await parent.close();
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited, mcpReadOnly: true };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.tools.map(tool => tool.external?.toolName)).toEqual(["echo"]);
    expect(lease.tools.every(tool => tool.contract.risk === "read")).toBe(true);
  } finally { await lease.close(); }
});

test("a server updated since the parent run degrades to a diagnostic instead of failing the child", async () => {
  const f = await fixture();
  const parent = await prepareMcpCapabilities(f.mcp, f.spec, new AbortController().signal);
  const inherited = parent.snapshot;
  await parent.close();
  await f.mcp.save({ ...f.server, expectedRevision: f.server.revision, name: "Changed" });
  const child: RunSpec = { ...f.spec, id: newId("run"), mcpSnapshot: undefined, mcpInherited: inherited };
  const lease = await prepareMcpCapabilities(f.mcp, child, new AbortController().signal, { inherited });
  try {
    expect(lease.snapshot).toHaveLength(0);
    expect(lease.tools).toEqual([]);
    expect(lease.diagnostics).toHaveLength(1);
    expect(lease.diagnostics[0]?.error).toMatch(/revision changed/);
  } finally { await lease.close(); }
});
```

`RunSpec` 与 `newId` 已在该文件第 8 行导入。

**`mcpSnapshot: undefined` 是刻意的，不要删。** 子任务不是恢复运行，必须走 `inherited` 路径而不是 `prior` 路径。虽然 `fixture()` 构造的 `f.spec` 本来就没有这个键、展开不会带上它，但显式写出能防止后来有人在同一个测试块里先设 `f.spec.mcpSnapshot = ...`（Task 1 的测试 2 就是这么写的），那样展开会把它带进子任务、改变走的路径。

已实测确认该写法合法：根 `tsconfig.json` 的 `exactOptionalPropertyTypes: true` 不阻止它，因为 zod 的 `z.infer` 对可选字段生成的是 `mcpSnapshot?: McpToolSnapshot[] | undefined`，类型本身含 `undefined`。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts -t "child"
```

预期：三条全部 FAIL —— `mcpInherited` 尚未存在于 `RunSpec` 类型，`options.inherited` 尚未被读取。若因类型不存在而编译失败，这是预期的 RED 状态。

- [ ] **Step 3: 协议新增字段**

`packages/protocol/src/index.ts`，在 line 449 的 `mcpReadOnly` 之后加入：

```ts
  mcpInherited: z.array(McpToolSnapshotSchema).max(16384).optional(),
```

`McpToolSnapshotSchema` 已在第 4 行导入。

- [ ] **Step 4: 实现 inherited 上限**

在 `packages/core/src/mcp-capabilities.ts` 中，`prepareMcpCapabilities` 签名改为：

```ts
export async function prepareMcpCapabilities(service: McpService, spec: RunSpec, signal: AbortSignal, options: { blobs?: EncryptedBlobStore; database?: HarnessDatabase; unresolvedCalls?: ToolCall[]; inherited?: McpToolSnapshot[] } = {}): Promise<RunCapabilityLease> {
```

在 Task 1 加入的 `readOnly` 之后加入：

```ts
  // A delegated child may only use what its parent was already approved for.
  // Recovery (`prior`) is stricter and wins; `inherited` only applies on first resolution.
  const inherited = prior ? undefined : options.inherited;
  const allowed = prior ?? inherited;
```

把 line 52 的服务器过滤改为：

```ts
    const servers = service.store.list().filter(server => server.enabled && server.projectPaths.some(path => mcpProjectKey(path) === mcpProjectKey(project)) && (!allowed || allowed.some(tool => tool.serverId === server.id)));
```

line 53 的恢复校验保持只看 `prior`（不变）。

在 `for (const server of servers) {` 之后、`try {` 之内，紧接 `signal.throwIfAborted();` 加入版本校验：

```ts
        let staleRevision = false;
        if (inherited) {
          const expected = inherited.find(tool => tool.serverId === server.id);
          if (expected && expected.revision !== server.revision) { staleRevision = true; throw new Error("MCP server revision changed since the parent run started"); }
        }
```

注意 `staleRevision` 必须在 `try` **之外**声明才能被 `catch` 读到，即：

```ts
      let staleRevision = false;
      try {
        signal.throwIfAborted();
        if (inherited) {
          const expected = inherited.find(tool => tool.serverId === server.id);
          if (expected && expected.revision !== server.revision) { staleRevision = true; throw new Error("MCP server revision changed since the parent run started"); }
        }
```

工具级过滤（line 66-68）改为：

```ts
          const saved = allowed?.find(tool => tool.name === name);
          if (allowed && !saved) continue;
          if (saved && (saved.contractHash !== contractHash || saved.risk !== risk)) {
            // Recovery must stay exact; a child silently narrows instead of failing.
            if (prior) throw new Error("MCP tool contract changed since this run started");
            continue;
          }
```

`catch` 块（line 109-114）的诊断消息按来源区分，**不**回显原始错误（原错误可能含 URL 或凭据）：

```ts
      } catch (error) {
        if (prior || signal.aborted) throw error;
        for (const [name, tool] of definitions) if (tool.external?.serverId === server.id) definitions.delete(name);
        for (let index = snapshot.length - 1; index >= 0; index--) if (snapshot[index]!.serverId === server.id) snapshot.splice(index, 1);
        diagnostics.push({ serverId: server.id, name: server.name, error: staleRevision ? "MCP service revision changed since the parent run started; start a new task to use the new configuration" : "MCP service unavailable; check its connection and authentication in the plugin page" });
      }
```

- [ ] **Step 5: 引擎传入 inherited**

`packages/core/src/engine.ts` 约 line 444，把现有的 `prepareMcpCapabilities` 调用整行替换为：

```ts
        capabilities = await prepareMcpCapabilities(this.deps.mcp, spec, state.controller.signal, { database: this.deps.database, ...(this.deps.blobs ? { blobs: this.deps.blobs } : {}), ...(recovery ? { unresolvedCalls: recovery.pendingNonIdempotentToolCalls } : {}), ...(spec.mcpInherited ? { inherited: spec.mcpInherited } : {}) });
```

与原行的唯一差别是末尾多出的 `...(spec.mcpInherited ? { inherited: spec.mcpInherited } : {})`。其余三个键名保持文件现状不变。

- [ ] **Step 6: 委派子任务设置继承与只读**

`packages/core/src/runtime.ts`，在 `runDelegatedTask` 的 `const child: RunSpec = {` 对象中，`createdAt: nowIso()` 之前加入两个字段：

```ts
          mcpReadOnly: task.mode === "read",
          ...(parentRun.mcpSnapshot ? { mcpInherited: parentRun.mcpSnapshot } : {}),
```

`parentRun` 即该函数的 `parentRun: RunSpec` 参数，其 `mcpSnapshot` 由父运行在 `engine.ts` 中落库后随 spec 一起读回。

- [ ] **Step 7: 运行测试确认通过**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts && pnpm typecheck
```

预期：14 项全部 PASS（原 9 + Task 1 的 2 + 本任务 3），typecheck 无错误。

- [ ] **Step 8: 确认委派路径整体无回归**

```bash
pnpm exec vitest run tests/delegation-lifecycle.test.ts tests/subagents.test.ts tests/mcp-service.test.ts
```

预期：全部 PASS。委派子任务的 spec 新增了两个可选字段，不影响既有断言。

---

### Task 3: `tool_started` 附带来源，并发射 `capabilities_resolved`

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/engine.ts`
- Test: `tests/mcp-runtime.test.ts`

**Interfaces:**
- Consumes: `prepareMcpCapabilities` 返回的 `RunCapabilityLease.{snapshot, diagnostics}`；`ToolDefinition.external`
- Produces: `ToolCallOriginSchema`；`AgentEvent` 的 `tool_started.origin?`；新事件类型 `capabilities_resolved`

- [ ] **Step 1: 写失败测试**

追加到 `tests/mcp-runtime.test.ts`。复用文件内既有的 `engine actually invokes a project MCP tool only after approval` 测试骨架，但断言事件内容：

```ts
test("the engine reports MCP tool origin and resolved capabilities to the UI stream", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0,
    listModels: async () => [descriptor({ providerId: "fake", modelId: "fake", displayName: "Fake" })],
    async *stream(request) {
      requests.push(request);
      // Only the first turn calls the tool; otherwise the run loops until its turn budget.
      if (requests.length === 1) {
        const tool = request.tools.find(tool => tool.description.includes("[Project service / echo]"));
        if (tool) yield { type: "tool_call", toolCall: { id: "origin-echo", name: tool.name, input: { value: "origin-probe" } } };
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(f.database), skills: new SkillService(join(f.root, "skills")), projectTrust: new ProjectTrustService(f.database), mcp: f.mcp });
  engine.on("event", (event: AgentEvent) => { if (event.type === "approval_required") engine.approvals.decide(event.approvalId, true, "test:user"); });
  const result = new Promise<AgentEvent>(resolve => { engine.on("event", event => { if (event.type === "result") resolve(event); }); });
  engine.start(f.spec, { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] });
  try {
    await result;
    while (engine.isActive(f.spec.id)) await new Promise(resolve => setTimeout(resolve, 10));
    const events = f.database.listEvents(f.spec.id);
    const started = events.find(event => event.type === "tool_started");
    expect(started?.origin).toMatchObject({ serverName: "Project service", toolName: "echo" });
    expect(started?.origin?.serverId).toBe(f.server.id);
    const resolved = events.find(event => event.type === "capabilities_resolved");
    expect(resolved?.mcp.length).toBeGreaterThan(0);
    expect(resolved?.skills).toBeDefined();
    expect(resolved?.diagnostics).toEqual([]);
  } finally { engine.cancel(f.spec.id); }
}, 20_000);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts -t "origin"
```

预期：FAIL —— `started?.origin` 为 `undefined`，且找不到 `capabilities_resolved` 事件。

- [ ] **Step 3: 协议新增 origin 与事件**

`packages/protocol/src/index.ts` 在 `ToolCallSchema` 定义（约 line 114-118）之后加入：

```ts
export const ToolCallOriginSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  toolName: z.string(),
  revision: z.number().int().positive(),
});
export type ToolCallOrigin = z.infer<typeof ToolCallOriginSchema>;
```

把 `AgentEventSchema` 中 `tool_started` 一行改为：

```ts
  z.object({ ...eventBase, type: z.literal("tool_started"), call: ToolCallSchema, origin: ToolCallOriginSchema.optional() }),
```

`tool_call` 一行**保持不变**（它在 `engine.ts:854` 由 provider 流事件发射，早于能力解析，拿不到 origin；桌面端也不消费它）。

在 `AgentEventSchema` 中 `workflow_updated` 之前加入新事件：

```ts
  z.object({
    ...eventBase,
    type: z.literal("capabilities_resolved"),
    mcp: z.array(McpToolSnapshotSchema),
    diagnostics: z.array(z.object({ serverId: z.string(), name: z.string(), error: z.string() })),
    skills: z.array(z.object({ key: z.string(), name: z.string() })),
  }),
```

- [ ] **Step 4: 引擎发射 origin**

`packages/core/src/engine.ts` 的 `executeTool`，约 line 690：

```ts
        executeTool: async (call, tool, signal) => {
          const external = capabilities?.resolve(call);
          if (external) { call = external.call; tool = external.tool; }
          this.emitEvent(spec.id, state, { type: "tool_started", call, ...(external?.tool.external ? { origin: { serverId: external.tool.external.serverId, serverName: external.tool.external.serverName, toolName: external.tool.external.toolName, revision: external.tool.external.revision } } : {}) });
```

`external.tool.external` 是 `ToolDefinition.external`，在 `mcp-capabilities.ts:72` 填充。按上面逐字段挑出而不是整体展开，是因为 `external` 还含 `contractHash`，而协议事件只声明四个字段。

- [ ] **Step 5: 引擎发射 capabilities_resolved**

在 `packages/core/src/engine.ts` 中，`createSkillRuntime` 调用（约 line 477）**之后**、`buildInitialMessages` 之前加入一次发射：

```ts
      this.emitEvent(spec.id, state, {
        type: "capabilities_resolved",
        mcp: capabilities?.snapshot ?? [],
        diagnostics: capabilities?.diagnostics ?? [],
        skills: trustedSkills.map(skill => ({ key: skill.key, name: skill.manifest.name })),
      });
```

`trustedSkills` 由同一作用域内上一行的 `resolveSelectedSkills` 产出。诊断为仅连接失败的服务，不含上游原始错误文本（`mcp-capabilities.ts` 已在源头脱敏）。

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm exec vitest run tests/mcp-runtime.test.ts && pnpm typecheck
```

预期：15 项全部 PASS，typecheck 无错误。

---

### Task 4: 桌面端展示来源、耗时与能力诊断

**Files:**
- Modify: `apps/desktop/src/tool-summary.ts`
- Modify: `apps/desktop/src/conversation-stream.ts`
- Modify: `apps/desktop/src/renderer.tsx`
- Test: `apps/desktop/src/tool-summary.test.ts`
- Test: `apps/desktop/src/conversation-stream.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ToolCallOrigin`；既有 `ToolTimelineItem.started.origin`
- Produces: `toolSummary(name, input, origin?)` 第三参数；origin 存在时 `detail` 为 `服务名 · 原名`

设计文档要求的四项里，**两项无需改动**：耗时已由 `ToolEventRow` 的 `<small>{finished.durationMs} ms</small>` 渲染；证据已由既有 `<ToolContext value={finished.output} />` 渲染（MCP 二进制结果在 output 里带 `attachment: { id, sha256, mimeType, byteLength }` 引用，随 output 一起显示）。本任务只补"原名与服务来源"这一项。

- [ ] **Step 1: 写失败测试**

追加到 `apps/desktop/src/tool-summary.test.ts`：

```ts
test("an MCP tool shows its service and original name instead of the namespaced name", () => {
  const origin = { serverId: "mcp_1", serverName: "项目工具", toolName: "read_project_status", revision: 3 };
  const summary = toolSummary("mcp_a1b2c3d4e5_read_project_status_f6g7h8i9j0", { value: 1 }, origin);
  // The row renders `detail`, not `label` — see renderer.tsx ToolEventRow.
  expect(summary.detail).toBe("项目工具 · read_project_status");
  expect(summary.kind).toBe("generic");
});

test("a local tool is unaffected by the origin parameter", () => {
  expect(toolSummary("read_file", { path: "a.ts" }).detail).toBe("a.ts");
  expect(toolSummary("read_file", { path: "a.ts" }, undefined).detail).toBe("a.ts");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run apps/desktop/src/tool-summary.test.ts
```

预期：第一条 FAIL，`summary.detail` 为 `""`；第二条 PASS。

- [ ] **Step 3: 实现 toolSummary 的 origin 分支**

`apps/desktop/src/tool-summary.ts`，把导入与函数签名改为：

```ts
import type { ToolCallOrigin } from "@harness/protocol";
import { parseDiff } from "./code-changes.js";
```

```ts
export function toolSummary(name: string, rawInput: unknown, origin?: ToolCallOrigin): ToolSummary {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  // Remote tools carry a namespaced name that means nothing to the user. The call row
  // renders `detail`, not `label`, so the human-readable identity must go in `detail`.
  if (origin) return { label: origin.toolName, detail: `${origin.serverName} · ${origin.toolName}`, kind: "generic" };
  if (["read_file", "read_range", "write_file"].includes(name)) {
```

其余分支不动。`toolActivity` 保持原样——它按 `name` 判断 `apply_patch`/`write_file`，MCP 工具落到 `已运行`，语义正确。

- [ ] **Step 4: 渲染来源徽标与耗时**

`apps/desktop/src/renderer.tsx` 的 `ToolEventRow`（约 line 1511），只需把 `toolSummary` 调用改为传入 origin：

```tsx
  const summary = toolSummary(started.call.name, started.call.input, started.origin);
```

**只需改这一行。** 该组件其余部分自动生效：`displayDetail` 取的正是 `summary.detail`，所以上面 `toolSummary` 的 origin 分支会直接渲染成 `<span>已运行</span> <strong>项目工具 · read_project_status</strong>`。

**不要加耗时显示。** 该组件的 `<small>` 已经在渲染 `finished.durationMs`：

```tsx
        <small className={failed ? "tool-call-failed" : ""}>
          {failed ? "失败 · " : ""}{finished ? `${finished.durationMs} ms` : "运行中"}
        </small>
```

再加一个会重复显示。设计文档要求的"耗时"这一项**已经满足**。

**不要加来源徽标。** `detail` 里已经带了服务名，再挂一个 `MCP` 徽标是冗余。设计文档要求的"原名与服务来源"由 detail 一条满足。

- [ ] **Step 5: 写失败测试（能力摘要）**

设计文档还要求"任务入口显示实际启用的 MCP 和技能及失败诊断"。`EventRow`（`renderer.tsx`）是一条 `if (event.type === "...")` 早返回链，对未知类型返回空，所以 `capabilities_resolved` 目前**什么都不显示**。

先做一个纯函数承载摘要逻辑，便于测试（沿用 `tool-summary.ts` 的既有模式）。追加到 `apps/desktop/src/conversation-stream.test.ts`，该文件用 `it` 而非 `test`，并有 `base` 常量：

```ts
it("summarizes resolved MCP capabilities and failure diagnostics", () => {
  const resolved = (mcp: unknown[], diagnostics: unknown[], skills: unknown[]) =>
    ({ ...base, id: "caps", sequence: 0, type: "capabilities_resolved", mcp, diagnostics, skills } as AgentEvent);
  const tool = { serverId: "s1", revision: 1, toolName: "echo", name: "mcp_x_echo_y", contractHash: "h", risk: "read" };
  expect(capabilitiesSummary(resolved([tool], [], [{ key: "k", name: "技能" }])))
    .toEqual({ label: "MCP 1 个工具 · 技能 1 个", detail: "1 个服务可用", warning: false });
  expect(capabilitiesSummary(resolved([], [{ serverId: "s2", name: "坏服务", error: "x" }], [])))
    .toEqual({ label: "MCP 0 个工具 · 技能 0 个", detail: "1 个服务不可用：坏服务", warning: true });
  // Every run emits this event; with nothing to report the row must stay hidden.
  expect(capabilitiesSummary(resolved([], [], []))).toBeUndefined();
});
```

**为什么空集要返回 `undefined`**：`capabilities_resolved` 对**每一次运行**无条件发射（含未配置 MCP 的运行），否则每个非 MCP 对话轮次都会多出一行 "MCP 0 个工具 · 技能 0 个"。抑制放在这个纯函数里而非渲染分支内，是为了可测试。不要改引擎去加守卫——技能是无条件解析的，按 `this.deps.mcp` 加守卫会让非 MCP 运行丢失技能信息。

并把导入行改为：

```ts
import { buildConversationStream, capabilitiesSummary, type ConversationStreamItem } from "./conversation-stream.js";
```

- [ ] **Step 6: 运行测试确认失败**

```bash
pnpm exec vitest run apps/desktop/src/conversation-stream.test.ts
```

预期：FAIL —— `capabilitiesSummary` 尚未导出。

- [ ] **Step 7: 实现摘要函数并接入渲染**

在 `apps/desktop/src/conversation-stream.ts` 末尾加入：

```ts
type CapabilitiesEvent = Extract<AgentEvent, { type: "capabilities_resolved" }>;

export function capabilitiesSummary(event: CapabilitiesEvent): { label: string; detail: string; warning: boolean } | undefined {
  // Emitted on every run; stay silent when there is nothing to report.
  if (!event.mcp.length && !event.diagnostics.length && !event.skills.length) return undefined;
  const warning = event.diagnostics.length > 0;
  return {
    label: `MCP ${event.mcp.length} 个工具 · 技能 ${event.skills.length} 个`,
    detail: warning
      ? `${event.diagnostics.length} 个服务不可用：${event.diagnostics.map(item => item.name).join("、")}`
      : `${new Set(event.mcp.map(tool => tool.serverId)).size} 个服务可用`,
    warning,
  };
}
```

在 `apps/desktop/src/renderer.tsx` 的 `EventRow` 中，与其他 `if (event.type === ...)` 分支并列加入一条（放在 `provider_retry` 分支之前）：

```tsx
  if (event.type === "capabilities_resolved") {
    const summary = capabilitiesSummary(event);
    if (!summary) return null;
    return (
      <div className={`activity-row${summary.warning ? " activity-row-warning" : ""}`}>
        <Plug size={15} aria-hidden="true" />
        <strong>{summary.label}</strong>
        <small>{summary.detail}</small>
      </div>
    );
  }
```

在 `renderer.tsx` 既有的 `lucide-react` 导入块（约 line 78 结尾）中加入 `Plug`。在 `conversation-stream` 的导入行（约 line 40）中加入 `capabilitiesSummary`。

**必须同时把事件加进流构建器的分派条件，否则上面这条 `EventRow` 分支是死代码。**

> **来源说明（2026-09-24）：** 本步骤**不在** Task 4 的初版计划中，是由 Task 4 的实现者发现的，事后补入。初版计划只写了"`EventRow` 对未知类型返回 null"，据此判定安全 —— 但漏了上游：`buildConversationStream` 是白名单式过滤，不在名单里的事件根本进不了 stream。没有这步，`capabilitiesSummary` 的纯函数测试全绿、`EventRow` 分支语法正确、typecheck 通过，而界面上永远不会显示。后续审查若依据本行反推"实现者声称计划遗漏"为误报，那是审查时点晚于本次补写的缘故。

`conversation-stream.ts` 约 line 94 是一个白名单式条件：

```ts
    } else if (event.type === "approval_required" || event.type === "error" || event.type === "provider_retry" || event.type === "self_correction_started" || event.type === "repair_started") {
```

不在这份名单里的事件**不会进入 stream**，`EventRow` 永远收不到。追加 `|| event.type === "capabilities_resolved"`。并补一条测试断言该事件确实以 `{ kind: "event" }` 出现在 stream 中。

**两处小修正（实测得出，照此写）：**

- 测试里的类型转换用 `as Extract<AgentEvent, { type: "capabilities_resolved" }>`，**不要**用 `as AgentEvent` —— 后者会拓宽成整个联合类型，导致三处 `capabilitiesSummary(...)` 调用点报 TS2345。
- `apps/desktop/src/tool-summary.test.ts` 用的是 `it` 而非 `test`（文件已导入 `it`），新测试沿用 `it`。

- [ ] **Step 8: 运行测试与类型检查**

```bash
pnpm exec vitest run apps/desktop/src/tool-summary.test.ts apps/desktop/src/conversation-stream.test.ts && pnpm typecheck
```

预期：全部 PASS。`ToolTimelineItem.started` 是 `ToolStartedEvent`，`origin` 作为可选字段自动流经 `conversation-stream.ts`，无需为该字段改动该文件。

---

### Task 5: 补齐计划遗留的验收用例

原计划执行记录自认未完成的验收项。全部是新增测试，若发现真实缺陷则在本任务内修复。

**Files:**
- Modify: `tests/mcp-client.test.ts`
- Modify: `tests/mcp-service.test.ts`
- Modify: `tests/mcp-skill-integration.test.ts`

- [ ] **Step 1: 同名工具与断线恢复（Task 2 遗留）**

同名工具追加到 `tests/mcp-client.test.ts`。该文件的 `open(extra)` 会把 `extra` 并入 `McpServerConfigSchema.parse`，而 `env` 是合法字段，`connectMcp` 会把它传给 stdio 传输：

```ts
test("a server that repeats a tool name is rejected as a protocol error", async () => {
  const connection = await open({ env: { FIXTURE_DUPLICATE_TOOLS: "1" } });
  await expect(connection.listTools(new AbortController().signal)).rejects.toMatchObject({ code: "protocol_error" });
});
```

`packages/extensions/test-fixtures/mcp-server.mjs:23` 已支持 `FIXTURE_DUPLICATE_TOOLS`，返回两个同名 `echo`。

断线恢复追加到 `tests/mcp-service.test.ts`。该文件的 `fixture()` 返回 `{ a, b, store, service, view }`，`signal()` 是文件内已有的信号工厂：

```ts
test("a closed connection is re-established instead of being reused", async () => {
  const { service, view, a } = await fixture();
  const first = await service.connect(view.id, a, signal());
  await first.close();
  const second = await service.connect(view.id, a, signal());
  expect(second).not.toBe(first);
  expect(second.closed).toBe(false);
  expect((await second.callTool("echo", {}, signal())).structuredContent).toMatchObject({ cwd: a });
});
```

- [ ] **Step 2: 技能侧的遗留验收（Task 5 遗留）**

在 `tests/mcp-skill-integration.test.ts` 中补两条。该文件 `fixture()` 已把全局根设为 `join(root, "global")`，项目技能位于 `.agent/skills` 下，且 `skills.ts:77-78` 按路径相对全局根的位置判定 `scope`、`skills.ts:60` 的 `key = skillKey(path)` 由路径派生。

第一条：同名技能放在两个不同目录，key 不同、scope 不同，`catalog` 中并列出现：

```ts
test("same-named global and project skills remain distinct in the catalog", async () => {
  const f = await fixture();
  const globalPath = join(f.root, "global", "project-status", "SKILL.md");
  await mkdir(join(f.root, "global", "project-status"), { recursive: true });
  await writeFile(globalPath, "---\nname: project-status\ndescription: Global variant\n---\nGLOBAL_VARIANT_RULE");
  const globalLoaded = await f.skills.load(globalPath);
  const globalTrusted = await f.skills.load(globalPath, globalLoaded.hash);
  f.database.saveSkill(globalTrusted.manifest);
  const runtime = createSkillRuntime({ documents: [globalTrusted, f.trusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: [] });
  const named = runtime.catalog.filter(entry => entry.name === "project-status");
  expect(named).toHaveLength(2);
  expect(new Set(named.map(entry => entry.source))).toEqual(new Set(["global", "project"]));
  expect(new Set(named.map(entry => entry.key)).size).toBe(2);
});
```

`runtime.catalog` 的 `source` 字段来自 `skill-runtime.ts:12` 的 `doc.scope`。

第二条：`missingTools` 报告技能声明但运行中没有的工具。既有测试已在 `toolNames: []` 下断言 `missingTools: ["echo"]`；这条补反向断言——把 `echo` 传入 `toolNames` 后不再报告：

```ts
test("missing tool diagnostics disappear once the tool is available", async () => {
  const f = await fixture();
  const context = { runId: f.spec.id, workspacePath: f.root, grants: [], signal: new AbortController().signal };
  const withTool = createSkillRuntime({ documents: [f.trusted], selected: [], spec: f.spec, skills: f.skills, database: f.database, toolNames: ["echo"] });
  const loaded = await withTool.tools.find(tool => tool.contract.name === "load_skill")!.execute({ key: f.trusted.key }, context);
  expect(loaded.output).toMatchObject({ missingTools: [] });
});
```

`f.trusted` 的 frontmatter 声明了 `tools: [echo]`，`skill-runtime.ts:47` 以 `doc.manifest.tools.filter(name => !options.toolNames.includes(name))` 计算该字段。

**取消与压缩后恢复**这两条不在此处补：`spec.skills` 的冻结写入已由既有测试第 47 行覆盖，取消路径由 Task 6 Step 2 的双项目端到端覆盖。避免为已覆盖行为写重复断言。

- [ ] **Step 3: 运行**

```bash
pnpm exec vitest run tests/mcp-client.test.ts tests/mcp-service.test.ts tests/mcp-skill-integration.test.ts
```

预期：全部 PASS。若某条暴露真实缺陷，先修复缺陷再继续，并在最终提交信息中记录。

---

### Task 6: 端到端验收、接入指南与全量验证

**Files:**
- Create: `docs/mcp.md`
- Modify: `apps/desktop/test-fixtures/mcp-preview.ts`

- [ ] **Step 1: OAuth 浏览器完整往返**

**不要新建 OAuth 服务** —— `packages/extensions/test-fixtures/mcp-server.mjs` 已内置完整 OAuth 模式（`mode === "oauth"`），提供 `/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/register`、`/authorize`、`/token`，并强制 Bearer 鉴权（401 + `WWW-Authenticate`），支持 refresh 与 access-version 递增。`tests/mcp-oauth.test.ts` 就是用 `spawn(fixture, "oauth")` 驱动它的。

扩展 `apps/desktop/test-fixtures/mcp-preview.ts`：照 `tests/mcp-oauth.test.ts:20` 的写法，用 `spawn(process.execPath, [fixture, "oauth"], { windowsHide: true, stdio: ["ignore","pipe","pipe"] })` 起该服务，从 stdout 首行 JSON 读 `url`，再用 `store.save({ name: "OAuth 服务", enabled: true, projectPaths: [root], transport: { type: "streamable_http", url } })` 存为第二个服务；进程退出时 `child.kill()`。

然后手工验证：

```bash
pnpm exec tsx apps/desktop/test-fixtures/mcp-preview.ts
```

在 `http://127.0.0.1:5199` 对这个服务点击「OAuth 登录」，浏览器完成授权后回到页面确认状态变为「OAuth 已登录」，再点「退出登录」确认回到未登录。把实际观察到的状态变化记录下来。

**注意**：程序化的 OAuth 覆盖（state/PKCE、加密存储、过期刷新、退出失效）已由 `tests/mcp-oauth.test.ts` 完成，本步**只**补浏览器往返这一段，不要重复写程序化断言。

- [ ] **Step 2: A/B 双项目端到端**

新增 `tests/mcp-e2e-projects.test.ts`。断言 A/B 两项目各自拿到自己的 roots，未绑定项目一个工具都拿不到——这是"连接的 cwd/roots 不得串项目"的直接证据。

```ts
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpService, McpStore } from "@harness/extensions";
import { DEFAULT_PROFILE, newId, nowIso, type RunSpec } from "@harness/protocol";
import { prepareMcpCapabilities } from "../packages/core/src/mcp-capabilities.js";

const serverFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("A/B projects keep separate roots while an unbound project receives no tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-e2e-")));
  const a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)]);
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-e2e-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const mcp = new McpService(new McpStore(database));
  cleanups.push(async () => { await mcp.close(); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  await mcp.save({ name: "Project service", enabled: true, projectPaths: [a, b], readOnlyTools: ["echo"], transport: { type: "stdio", command: process.execPath, args: [serverFile] } });
  const specFor = (workspacePath: string): RunSpec => ({ id: newId("run"), sessionId: "session", profileId: "default", workspacePath, request: "status", attachments: [], grants: [], budget: { ...DEFAULT_PROFILE.budget, maxTurns: 4 }, createdAt: nowIso() });

  const leaseA = await prepareMcpCapabilities(mcp, specFor(a), new AbortController().signal);
  const leaseB = await prepareMcpCapabilities(mcp, specFor(b), new AbortController().signal);
  const leaseC = await prepareMcpCapabilities(mcp, specFor(c), new AbortController().signal);
  try {
    expect(leaseA.snapshot).toHaveLength(4);
    expect(leaseB.snapshot).toHaveLength(4);
    expect(leaseC.snapshot).toHaveLength(0);
    expect(leaseC.tools).toEqual([]);

    const call = async (lease: typeof leaseA, workspacePath: string) => {
      const tool = lease.tools.find(candidate => candidate.external?.toolName === "echo")!;
      const result = await tool.execute({ value: "roots-check" }, { runId: "run", workspacePath, grants: [], signal: new AbortController().signal });
      return (result.output as { structuredContent?: { cwd?: string; roots?: Array<{ uri: string }> } }).structuredContent;
    };
    expect(await call(leaseA, a)).toMatchObject({ cwd: a, roots: [{ uri: pathToFileURL(a).href }] });
    expect(await call(leaseB, b)).toMatchObject({ cwd: b, roots: [{ uri: pathToFileURL(b).href }] });
  } finally {
    await leaseA.close(); await leaseB.close(); await leaseC.close();
  }
});
```

`echo` 的 `structuredContent` 携带 `{ cwd, roots, pid }`，见 `tests/mcp-service.test.ts:33-34` 的既有断言写法。

只读子任务零写调用**不在此重复**：能力层已由 Task 2 的 `a read-only child cannot receive write tools even when its parent had them` 覆盖，接线层由 Task 2 Step 8 的 `tests/delegation-lifecycle.test.ts` 覆盖。本测试只补 roots 不串项目这一条无法在别处验证的证据。

- [ ] **Step 3: 全量验证**

```bash
pnpm typecheck
pnpm exec vitest run
pnpm build
```

预期：三者全部通过。读取所有失败详情；只有当前变更或发现的实质问题才触发重复验证。把结果与失败详情记录到 `docs/audits/`。

- [ ] **Step 4: 写接入指南**

创建 `docs/mcp.md`，覆盖：stdio 的命令/参数/环境变量示例、Streamable HTTP 与 SSE 的地址与请求头配置、OAuth 登录与退出流程、项目绑定语义（同一服务可绑多项目但连接按项目隔离）、`readOnlyTools` 的风险分类含义与"仍受审批约束"的说明、只读委派子任务的能力收窄行为、大工具目录的 `mcp_search`/`mcp_call` 降级、常见诊断（连接失败、认证失败、revision 变化、未知写结果不重放）。所有示例不得含真实凭据。

- [ ] **Step 5: 独立审查并提交**

对照 `docs/superpowers/specs/2026-09-24-mcp-remaining-work-design.md` 逐条核验，修复实质问题。全部完成后，按用户指令提交工作区全部更改：

```bash
git add -A
git commit -m "feat(mcp): fix delegated capability inheritance and surface task capabilities"
```

提交信息末尾不加 Co-Authored-By（用户全局配置已禁用归属）。提交前用 `git status` 复核暂存范围包含进行中的 UI 修改——这是用户明确要求的。

---

## 执行记录

- 2026-09-24 实现与审查（Task 1–5 各经实现 + 规格审查 + 质量审查，Important 项修复后复审通过）：
  - Task 1 只读接线与长度校验修复；Task 2 委派继承与只读边界（含 `mcp_call` 风险标签派生、`prior` 优先级测试两项 Important 修复）；Task 3 `tool_started.origin` 与 `capabilities_resolved`（含恢复路径重复发射守卫）；Task 4 桌面渲染（含流构建器分派条件补漏、`CapabilitiesRow` 组件抽取）；Task 5 四条遗留验收用例。
  - 累计修正初版计划 12 处。其中 4 处属"测试全绿但功能不生效"的静默失败类，均只能通过读真实代码或端到端追调用链发现，无法被既有测试捕获。
- 2026-09-24 Task 6 Step 1 OAuth 浏览器往返**由用户在真实浏览器实测通过**：授权页正常打开、回调页显示 `MCP login complete`、卡片状态按 未登录 → 等待中 → 「OAuth 已登录」 流转、「退出登录」后恢复未登录。
  - 环境注意：本机 `HTTP_PROXY`/`HTTPS_PROXY` 指向 `http://127.0.0.1:15556` 且未排除本机地址，直连 `127.0.0.1:5199` 会被代理拦截返回 503（`curl` 实测）。浏览器需将 `127.0.0.1`/`localhost` 加入代理排除列表。
- 2026-09-24 可执行验证：`pnpm typecheck` 干净、`pnpm exec vitest run` 582 项 / 95 文件全部通过、`pnpm build` exit=0。测试基线由起点 565 增至 582。

## 完成标准

1. Task 1-4 的新增用例先失败后通过，既有 44 项 MCP 测试零回归
2. 只读委派子任务拿不到 MCP 写工具，且恢复后仍拿不到
3. 子任务工具目录 ⊆ 父任务冻结目录；父任务运行期间无关服务变更降级为诊断
4. 桌面端对话记录显示 MCP 来源与耗时，任务入口显示本次启用的服务、技能与失败诊断
5. `pnpm typecheck`、`pnpm exec vitest run`、`pnpm build` 全部通过
6. `docs/mcp.md` 完成且不含真实凭据
7. 工作区全部更改已提交

不把"页面存在"或"单独连接成功"当作完成证据。完成声明必须附实际运行结果。
