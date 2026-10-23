import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type ApprovalRequest, type ModelRequest, type Profile, type RunSpec } from "@harness/protocol";
import { createDefaultToolRegistry } from "@harness/tools";
import { workflowPrelude, workflowReadTool } from "./workflow-fixture.js";

afterEach(() => vi.useRealTimers());
const content = "export const suspendedApproval = true;\n";

async function fixture(workflowVersion: 1 | 2 | 3) {
  const root = await mkdtemp(join(tmpdir(), "harness-approval-suspend-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const vault = await VaultCrypto.open(join(root, "key.json"), "approval-suspend-test-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const model = descriptor({ providerId: "suspend-fixture", modelId: "suspend-fixture", displayName: "Approval suspension fixture", maxContextTokens: 128000 });
  const provider: ModelProvider = {
    id: model.providerId, listModels: async () => [model], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      requests.push(structuredClone(request));
      if (workflowVersion === 1 && requests.length <= 3) { yield* workflowPrelude(requests.length); return; }
      // The fixture tests one actual write, rather than the agent's completion policy.
      if (events.some(event => event.type === "tool_finished" && event.output && typeof event.output === "object" && "written" in event.output && event.output.written === true)) {
        engine.cancel(request.runId);
        return;
      }
      yield { type: "tool_call", toolCall: { id: `write-${requests.length}`, name: "write_file", input: { path: "source.ts", content } } };
    },
  };
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [provider.id], toolNames: ["write_file", ...(workflowVersion === 1 ? ["read_file"] : [])], memoryScopes: [], generationPolicy: { maxOutputTokens: 2048 } };
  const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Create source.ts with the requested value", workflowVersion, taskMode: "auto", workspacePath: workspace, profileId: profile.id, attachments: [], grants: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 10, maxToolCalls: 50, maxDurationMs: 20000 } };
  database.createSession({ id: spec.sessionId, title: "Approval suspension", workspacePath: workspace, profileId: profile.id, createdAt: spec.createdAt, updatedAt: spec.createdAt });
  const tools = createDefaultToolRegistry();
  if (workflowVersion === 1) { tools.unregister("read_file"); tools.register(workflowReadTool); }
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  engine.on("event", (event: AgentEvent) => { if (event.runId === spec.id) events.push(event); });
  const waiting = new Set<() => void>();
  function next<T extends AgentEvent["type"]>(type: T, after = events.length, accept: (event: Extract<AgentEvent, { type: T }>) => boolean = () => true): Promise<Extract<AgentEvent, { type: T }>> {
    const existing = events.slice(after).find(event => event.type === type && accept(event as Extract<AgentEvent, { type: T }>));
    if (existing) return Promise.resolve(existing as Extract<AgentEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); engine.off("event", listener); waiting.delete(cleanup); };
      const listener = (event: AgentEvent) => {
        if (event.runId !== spec.id || event.type !== type || !accept(event as Extract<AgentEvent, { type: T }>)) return;
        cleanup(); resolve(event as Extract<AgentEvent, { type: T }>);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Approval suspension fixture timed out waiting for ${type}`)); }, 8000);
      waiting.add(cleanup); engine.on("event", listener);
    });
  }
  async function startWaiting() {
    const approval = next("approval_required");
    engine.start(spec, profile);
    const event = await approval;
    return database.getApproval(event.approvalId)!;
  }
  async function pause() {
    const result = next("result");
    expect(engine.pause(spec.id)).toBe(true);
    expect((await result).status).toBe("paused");
    await engine.waitForSettlement(spec.id);
    expect(database.getRun(spec.id)?.status).toBe("paused");
  }
  async function resumeWaiting() {
    const approval = next("approval_required");
    engine.resume(spec.id, profile);
    return approval;
  }
  async function approveAndWait(approvalId: string) {
    const result = next("result");
    engine.approvals.decide(approvalId, true, "fixture:user");
    await result;
    await engine.waitForSettlement(spec.id);
  }
  async function assertNoWrite() {
    expect(events.filter(event => event.type === "tool_started" && event.call.name === "write_file")).toEqual([]);
    expect(database.getRun(spec.id)?.spec.grants).toEqual([]);
    await expect(readFile(join(workspace, "source.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }
  async function assertOneWrite(approval: ApprovalRequest) {
    expect(await readFile(join(workspace, "source.ts"), "utf8")).toBe(content);
    expect(events.filter(event => event.type === "tool_started" && event.call.name === "write_file")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_finished" && event.output && typeof event.output === "object" && "written" in event.output && event.output.written === true)).toHaveLength(1);
    expect(database.getRun(spec.id)?.spec.grants).toEqual([approval.requestedGrant]);
  }
  return { root, workspace, database, engine, spec, profile, events, requests, next, startWaiting, pause, resumeWaiting, approveAndWait, assertNoWrite, assertOneWrite,
    async close() {
      for (const cleanup of waiting) cleanup();
      for (const approval of database.listApprovals()) if (approval.status === "pending") engine.approvals.decideIfPending(approval.id, false, "fixture:cleanup");
      await engine.close(); database.close(); vault.dispose();
      const withinTemp = relative(tmpdir(), root);
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe approval fixture cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

describe.each([2, 3] as const)("approval suspension through workflow %s", workflowVersion => {
  it("keeps a pending approval and deadline, then reattaches the same ID before a model or tool runs", async () => {
    const h = await fixture(workflowVersion);
    try {
      const approval = await h.startWaiting();
      await h.pause();
      expect(h.database.getApproval(approval.id)).toEqual(approval);
      expect(h.database.getLatestCheckpoint(h.spec.id)).toMatchObject({ suspendedApprovalIds: [approval.id] });
      await h.assertNoWrite();
      const requestsBeforeResume = h.requests.length;
      const resumed = await h.resumeWaiting();
      expect(resumed.approvalId).toBe(approval.id);
      expect(h.requests).toHaveLength(requestsBeforeResume);
      expect(h.database.listApprovals()).toHaveLength(1);
      expect(h.database.getApproval(approval.id)).toEqual(approval);
      await h.assertNoWrite();
      await h.approveAndWait(approval.id);
      await h.assertOneWrite(approval);
    } finally { await h.close(); }
  }, 20000);

  it("stores approval while paused without executing or granting anything until explicit resume", async () => {
    const h = await fixture(workflowVersion);
    try {
      const approval = await h.startWaiting();
      await h.pause();
      h.engine.approvals.decide(approval.id, true, "fixture:paused-user");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.database.getApproval(approval.id)).toMatchObject({ status: "approved", decidedBy: "fixture:paused-user", expiresAt: approval.expiresAt });
      expect(h.database.getRun(h.spec.id)?.status).toBe("paused");
      await h.assertNoWrite();
      const result = h.next("result");
      h.engine.resume(h.spec.id, h.profile);
      await result; await h.engine.waitForSettlement(h.spec.id);
      await h.assertOneWrite(approval);
      expect(h.database.listApprovals()).toHaveLength(1);
    } finally { await h.close(); }
  }, 20000);

  it("supports repeated pause and resume without minting replacement approvals or extending the deadline", async () => {
    const h = await fixture(workflowVersion);
    try {
      const approval = await h.startWaiting();
      await h.pause();
      for (let index = 0; index < 2; index++) {
        expect((await h.resumeWaiting()).approvalId).toBe(approval.id);
        await h.pause();
        expect(h.database.getApproval(approval.id)).toEqual(approval);
        expect(h.database.listApprovals()).toHaveLength(1);
        await h.assertNoWrite();
      }
      expect((await h.resumeWaiting()).approvalId).toBe(approval.id);
      await h.approveAndWait(approval.id);
      await h.assertOneWrite(approval);
    } finally { await h.close(); }
  }, 20000);
});

describe("suspended approval boundaries", () => {
  it("retains a legacy plan decision made synchronously after resume before its waiter attaches", async () => {
    const h = await fixture(1);
    try {
      const planRequired = h.next("plan_approval_required");
      h.engine.start(h.spec, h.profile);
      const first = await planRequired;
      await h.pause();
      await h.assertNoWrite();
      const toolRequired = h.next("approval_required");
      h.engine.resume(h.spec.id, h.profile);
      // resume has copied the awaiting plan, but execute has not attached a waiter yet.
      h.engine.decidePlan(first.planId, first.version, true, "fixture:resume-window");
      const toolEvent = await toolRequired;
      expect(h.database.getPlan(first.planId)).toMatchObject({ status: "approved", version: first.version, approvedBy: "fixture:resume-window" });
      expect(h.events.filter(event => event.type === "plan_approval_required")).toHaveLength(1);
      const approval = h.database.getApproval(toolEvent.approvalId)!;
      await h.pause();
      h.engine.approvals.decide(approval.id, true, "fixture:paused-user");
      await h.assertNoWrite();
      const result = h.next("result");
      h.engine.resume(h.spec.id, h.profile);
      await result; await h.engine.waitForSettlement(h.spec.id);
      await h.assertOneWrite(approval);
      expect(h.database.getPlan(first.planId)).toMatchObject({ status: "approved", version: first.version, approvedBy: "fixture:resume-window" });
      expect(h.events.filter(event => event.type === "plan_approval_required")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20000);

  it("records an explicit legacy plan approval while paused without dispatching until resume", async () => {
    const h = await fixture(1);
    try {
      const planRequired = h.next("plan_approval_required");
      h.engine.start(h.spec, h.profile);
      const first = await planRequired;
      await h.pause();
      const requestsWhilePaused = h.requests.length;
      h.engine.decidePlan(first.planId, first.version, true, "fixture:paused-user");
      expect(h.database.getPlan(first.planId)).toMatchObject({ status: "approved", version: first.version, approvedBy: "fixture:paused-user" });
      expect(h.requests).toHaveLength(requestsWhilePaused);
      expect(h.database.getRun(h.spec.id)?.status).toBe("paused");
      await h.assertNoWrite();
      const toolRequired = h.next("approval_required");
      h.engine.resume(h.spec.id, h.profile);
      const toolEvent = await toolRequired;
      const approval = h.database.getApproval(toolEvent.approvalId)!;
      await h.approveAndWait(approval.id);
      await h.assertOneWrite(approval);
      expect(h.database.getPlan(first.planId)).toMatchObject({ status: "approved", version: first.version, approvedBy: "fixture:paused-user" });
      expect(h.events.filter(event => event.type === "plan_approval_required")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20000);

  it("preserves the awaiting legacy plan and version, then reattaches it before provider dispatch", async () => {
    const h = await fixture(1);
    try {
      const planRequired = h.next("plan_approval_required");
      h.engine.start(h.spec, h.profile);
      const first = await planRequired;
      const plan = h.database.getPlan(first.planId)!;
      expect(plan).toMatchObject({ status: "awaiting_approval", version: first.version });
      await h.pause();
      expect(h.database.getPlan(first.planId)).toEqual(plan);
      await h.assertNoWrite();
      const requestCount = h.requests.length;
      const reattached = h.next("plan_approval_required");
      h.engine.resume(h.spec.id, h.profile);
      expect(await reattached).toMatchObject({ planId: first.planId, version: first.version });
      expect(h.requests).toHaveLength(requestCount);
      expect(h.database.getPlan(first.planId)).toEqual(plan);
      const toolRequired = h.next("approval_required");
      h.engine.decidePlan(first.planId, first.version, true, "fixture:user");
      const toolEvent = await toolRequired;
      const approval = h.database.getApproval(toolEvent.approvalId)!;
      await h.approveAndWait(approval.id);
      await h.assertOneWrite(approval);
      expect(h.database.getPlan(first.planId)).toMatchObject({ status: "approved", version: first.version });
    } finally { await h.close(); }
  }, 20000);

  it("keeps cancellation distinct from suspension after a pending approval reattaches", async () => {
    const h = await fixture(3);
    try {
      const approval = await h.startWaiting();
      await h.pause();
      expect((await h.resumeWaiting()).approvalId).toBe(approval.id);
      const result = h.next("result");
      expect(h.engine.cancel(h.spec.id)).toBe(true);
      expect((await result).status).toBe("cancelled");
      await h.engine.waitForSettlement(h.spec.id);
      expect(h.database.getApproval(approval.id)).toMatchObject({ status: "denied", decidedBy: "system:cancelled" });
      await h.assertNoWrite();
    } finally { await h.close(); }
  }, 20000);

  it("cancels every preserved approval even when recovery has only reattached its first waiter", async () => {
    const h = await fixture(3);
    try {
      const first = await h.startWaiting();
      await h.pause();
      const extra = h.engine.approvals.request({
        runId: h.spec.id, toolName: first.toolName, normalizedInput: { path: "second.ts", content }, risk: first.risk,
        reason: "A second pending call captured at the same pause boundary", requestedGrant: { ...first.requestedGrant, exactPathInputs: { path: "second.ts", filePath: null, cwd: null } },
      }, new AbortController().signal);
      h.engine.approvals.suspendRun(h.spec.id);
      expect(await extra.decision).toBe(false);
      const checkpoint = h.database.getLatestCheckpoint(h.spec.id)!;
      h.database.saveCheckpoint({ ...checkpoint, suspendedApprovalIds: [first.id, extra.approval.id] });
      expect((await h.resumeWaiting()).approvalId).toBe(first.id);
      const result = h.next("result");
      h.engine.cancel(h.spec.id);
      expect((await result).status).toBe("cancelled");
      await h.engine.waitForSettlement(h.spec.id);
      for (const id of [first.id, extra.approval.id]) expect(h.database.getApproval(id)).toMatchObject({ status: "denied", decidedBy: "system:cancelled" });
      await h.assertNoWrite();
    } finally { await h.close(); }
  }, 20000);

  it("does not revive an approval whose original deadline expired while the run was paused", async () => {
    const h = await fixture(3);
    try {
      const approval = await h.startWaiting();
      await h.pause();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(approval.expiresAt) + 1);
      const replacement = h.next("approval_required", h.events.length, event => event.approvalId !== approval.id);
      h.engine.resume(h.spec.id, h.profile);
      const resumed = await replacement;
      expect(h.database.getApproval(approval.id)).toMatchObject({ status: "expired", expiresAt: approval.expiresAt });
      expect(resumed.approvalId).not.toBe(approval.id);
      await h.assertNoWrite();
      const result = h.next("result");
      h.engine.cancel(h.spec.id);
      expect((await result).status).toBe("cancelled");
      await h.engine.waitForSettlement(h.spec.id);
    } finally { vi.useRealTimers(); await h.close(); }
  }, 20000);
});
