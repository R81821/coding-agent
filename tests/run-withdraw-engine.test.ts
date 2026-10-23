import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessEngine, ProjectTrustService, RunReviewService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, type AgentEvent, type AttachmentRef, type ModelRequest, type Profile, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function nextResult(engine: HarnessEngine, runId: string) {
  return new Promise<Extract<AgentEvent, { type: "result" }>>(resolve => {
    const listener = (event: AgentEvent) => {
      if (event.runId !== runId || event.type !== "result") return;
      engine.off("event", listener);
      resolve(event);
    };
    engine.on("event", listener);
  });
}

async function fixture(tools = new ToolRegistry(), options: {
  responseText?: (request: ModelRequest, index: number) => string;
  readToolCallId?: (request: ModelRequest, index: number) => string;
  toolName?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-withdraw-engine-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "dirty before sending\n");
  const crypto = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(root, "app.sqlite"), crypto);
  const at = "2026-10-11T00:00:00.000Z";
  for (const id of ["session", "other"]) database.createSession({ id, title: id, workspacePath: workspace, profileId: "default", createdAt: at, updatedAt: at });
  const requests: ModelRequest[] = [];
  const waiting = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; mutate?: () => Promise<void> }>();
  const model = descriptor({ providerId: "withdraw", modelId: "local-fixture", displayName: "Withdraw fixture", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 1_000_000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "withdraw", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      const blocked = waiting.get(request.runId);
      if (blocked) {
        waiting.delete(request.runId);
        await blocked.mutate?.();
        blocked.entered.resolve();
        await blocked.release.promise;
      }
      const responseText = options.responseText?.(request, requests.length);
      if (responseText) yield { type: "text_delta", delta: responseText };
      const readToolCallId = options.readToolCallId?.(request, requests.length) ?? `read-${request.runId}`;
      const hasRead = request.messages.some(message => message.content.some(part => part.type === "tool_result" && part.toolCallId === readToolCallId));
      if (!hasRead) yield { type: "tool_call", toolCall: { id: readToolCallId, name: options.toolName ?? "read_file", input: { path: "source.txt" } } };
      else yield { type: "text_delta", delta: "The source file was inspected." };
      yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7, estimatedUsd: 0, costKnown: true } };
    },
  };
  const review: RunReviewService = new RunReviewService(join(root, "reviews"), crypto, {
    getRun: id => database.getRun(id)?.spec,
    activeRuns: () => engine.activeReviewRuns(),
    activeWorkspaces: () => engine.activeWorkspacePaths(),
  });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [provider.id], toolNames: [options.toolName ?? "read_file"], generationPolicy: { maxOutputTokens: 8192 } };
  const engine: HarnessEngine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database), review });
  let counter = 0;
  const gates: Array<ReturnType<typeof deferred>> = [];
  function spec(overrides: Partial<RunSpec> = {}): RunSpec {
    counter++;
    return { id: `run-${counter}`, sessionId: "session", request: `request-${counter}`, workspacePath: workspace, profileId: profile.id, budget: { ...profile.budget, maxTurns: 8 }, workflowVersion: 2, taskMode: "analysis", attachments: [], grants: [], createdAt: new Date(Date.parse(at) + counter).toISOString(), ...overrides };
  }
  function block(run: RunSpec, mutate?: () => Promise<void>) {
    const entered = deferred(), release = deferred();
    gates.push(release);
    waiting.set(run.id, { entered, release, ...(mutate ? { mutate } : {}) });
    return { entered, release };
  }
  async function pause(run: RunSpec, mutate?: () => Promise<void>) {
    const gate = block(run, mutate), result = nextResult(engine, run.id);
    engine.start(run, profile);
    await gate.entered.promise;
    expect(engine.pause(run.id)).toBe(true);
    gate.release.resolve();
    expect((await result).status).toBe("paused");
    await engine.waitForSettlement(run.id);
  }
  async function steerAndPause(run: RunSpec, text: string, mutate?: () => Promise<void>) {
    const gate = block(run, mutate), result = nextResult(engine, run.id);
    const submitted = await engine.steerAndResume(run.id, text, profile);
    expect(submitted).toMatchObject({ accepted: true, resumed: true });
    if (!submitted.accepted) throw new Error("Fixture message unexpectedly rejected");
    await gate.entered.promise;
    expect(engine.pause(run.id)).toBe(true);
    gate.release.resolve();
    expect((await result).status).toBe("paused");
    await engine.waitForSettlement(run.id);
    return submitted;
  }
  return { root, workspace, database, engine, review, profile, spec, block, pause, steerAndPause, requests,
    async close() {
      gates.forEach(gate => gate.resolve());
      await engine.close();
      database.close(); crypto.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("latest paused conversation withdrawal", { timeout: 20_000 }, () => {
  it("pauses a tool awaiting approval without granting or executing it, then restores this round's edits", async () => {
    const execute = vi.fn(async () => ({ output: { read: true } }));
    const tools = new ToolRegistry().register({
      requiresApproval: true,
      contract: { name: "read_file", description: "Approval fixture read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
      execute,
    });
    const h = await fixture(tools);
    try {
      const run = h.spec();
      const gate = h.block(run, () => writeFile(join(h.workspace, "source.txt"), "changes made before the next approval\n"));
      const approval = new Promise<string>(resolve => h.engine.on("event", event => {
        if (event.runId === run.id && event.type === "approval_required") resolve(event.approvalId);
      }));
      const result = nextResult(h.engine, run.id);
      h.engine.start(run, h.profile);
      await gate.entered.promise;
      gate.release.resolve();
      const approvalId = await approval;
      expect(h.database.getRun(run.id)?.status).toBe("waiting_approval");
      expect(h.engine.pause(run.id)).toBe(true);
      expect((await result).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      expect(h.database.getApproval(approvalId)).toMatchObject({ status: "pending" });
      expect(h.database.getApproval(approvalId)?.decidedBy).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(h.database.getRun(run.id)?.spec.grants).toEqual([]);
      await h.engine.withdraw(run.id);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("dirty before sending\n");
      expect(h.database.getRun(run.id)).toBeUndefined();
    } finally { await h.close(); }
  });

  it("does not start a tool or extend grants when pause races an accepted approval", async () => {
    const execute = vi.fn(async () => ({ output: { read: true } }));
    const tools = new ToolRegistry().register({
      requiresApproval: true,
      contract: { name: "read_file", description: "Approval race fixture", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 1000 }, execute,
    });
    const h = await fixture(tools);
    try {
      const run = h.spec(), result = nextResult(h.engine, run.id);
      h.engine.on("event", event => {
        if (event.runId === run.id && event.type === "approval_required") {
          h.engine.approvals.decide(event.approvalId, true, "fixture:user");
          h.engine.pause(run.id);
        }
      });
      h.engine.start(run, h.profile);
      expect((await result).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      expect(execute).not.toHaveBeenCalled();
      expect(h.database.getRun(run.id)?.spec.grants).toEqual([]);
      await h.engine.withdraw(run.id);
    } finally { await h.close(); }
  });

  it("waits for a real pause, restores pre-send bytes and returns the exact request and attachments", async () => {
    const h = await fixture();
    try {
      const attachment: AttachmentRef = { id: "picture", mimeType: "image/png", sha256: "a".repeat(64), byteLength: 1, encryptedPath: "encrypted", source: "file", trust: "untrusted_attachment", allowedProviders: [], createdAt: "2026-10-11T00:00:00.000Z" };
      const run = h.spec({ request: "the accidental request\nwith its line break", attachments: [attachment] });
      // Attachment transport is covered by the stored RunSpec; the fake non-vision provider must
      // not route it, so seed it after the real pause while retaining the actual file snapshot.
      const live = { ...run, attachments: [] };
      const gate = h.block(live, () => writeFile(join(h.workspace, "source.txt"), "modified by this round\n"));
      const result = nextResult(h.engine, live.id);
      h.engine.start(live, h.profile);
      await gate.entered.promise;
      h.engine.pause(live.id);
      await expect(h.engine.withdraw(live.id)).rejects.toThrow(/暂停|运行/);
      gate.release.resolve();
      expect((await result).status).toBe("paused");
      await h.engine.waitForSettlement(live.id);
      h.database.saveRun({ ...h.database.getRun(live.id)!.spec, attachments: run.attachments }, "paused");
      const withdrawn = await h.engine.withdraw(live.id);
      expect(withdrawn).toMatchObject({ run: { id: live.id, request: run.request, attachments: [attachment] }, withdrawnRunIds: [live.id] });
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("dirty before sending\n");
      expect(h.database.getRun(live.id)).toBeUndefined();
      expect(h.database.getSessionDetail("session")?.runs).toHaveLength(0);
      expect(() => h.engine.resume(live.id, h.profile)).toThrow();
      expect(() => h.engine.start(live, h.profile)).toThrow(/撤回/);
    } finally { await h.close(); }
  });

  it("rejects completed and all other nonpaused states, old rounds and child-only withdrawal", async () => {
    const h = await fixture();
    try {
      const completed = h.spec();
      const result = nextResult(h.engine, completed.id);
      h.engine.start(completed, h.profile);
      expect((await result).status).toBe("completed");
      await h.engine.waitForSettlement(completed.id);
      await expect(h.engine.withdraw(completed.id)).rejects.toThrow(/暂停/);
      for (const status of ["queued", "planning", "running", "verifying", "waiting_approval", "review", "failed", "cancelled"] as const) {
        const run = h.spec(); h.database.saveRun(run, status);
        await expect(h.engine.withdraw(run.id)).rejects.toThrow(/暂停/);
      }
      const old = h.spec(); h.database.saveRun(old, "paused");
      const latest = h.spec(); h.database.saveRun(latest, "paused");
      await expect(h.engine.withdraw(old.id)).rejects.toThrow(/最新/);
      const child = h.spec({ parentRunId: latest.id }); h.database.saveRun(child, "paused");
      await expect(h.engine.withdraw(child.id)).rejects.toThrow(/暂停/);
      expect(h.database.getRun(completed.id)?.status).toBe("completed");
    } finally { await h.close(); }
  });

  it("publishes paused only after the end snapshot is frozen and holds actions while withdrawal awaits", async () => {
    const h = await fixture();
    const cleanupEntered = deferred(), cleanupRelease = deferred();
    const originalFinish = h.review.finish.bind(h.review);
    const finishSpy = vi.spyOn(h.review, "finish").mockImplementation(async (id, paused) => {
      await originalFinish(id, paused);
      if (paused) { cleanupEntered.resolve(); await cleanupRelease.promise; }
    });
    try {
      const run = h.spec(), gate = h.block(run), result = nextResult(h.engine, run.id);
      let published = false;
      void result.then(() => { published = true; });
      h.engine.start(run, h.profile); await gate.entered.promise;
      h.engine.pause(run.id); gate.release.resolve();
      await cleanupEntered.promise;
      await Promise.resolve();
      expect(published).toBe(false);
      expect(h.database.getRun(run.id)?.status).not.toBe("paused");
      await expect(h.engine.withdraw(run.id)).rejects.toThrow(/暂停/);
      cleanupRelease.resolve();
      expect((await result).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      await h.engine.withdraw(run.id);
      finishSpy.mockRestore();
      const second = h.spec(); await h.pause(second);
      const rootEntered = deferred(), rootRelease = deferred();
      const rootFor = h.review.withdrawalRoot.bind(h.review);
      const rootSpy = vi.spyOn(h.review, "withdrawalRoot").mockImplementation(async id => { rootEntered.resolve(); await rootRelease.promise; return rootFor(id); });
      const nextWithdrawal = h.engine.withdraw(second.id);
      await rootEntered.promise;
      expect(() => h.engine.resume(second.id, h.profile)).toThrow(/撤回/);
      expect(() => h.engine.start(h.spec({ sessionId: "other" }), h.profile)).toThrow(/撤回/);
      expect(() => h.engine.assertSessionMutationAllowed("session")).toThrow(/撤回/);
      expect(() => h.engine.assertWorkspaceMutationAllowed(h.workspace)).toThrow(/撤回/);
      rootRelease.resolve(); await nextWithdrawal; rootSpy.mockRestore();
    } finally { cleanupRelease.resolve(); finishSpy.mockRestore(); await h.close(); }
  });

  it("rejects post-pause manual edits without deleting the round or changing any file", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run, async () => {
        await writeFile(join(h.workspace, "source.txt"), "round changed this\n");
        await writeFile(join(h.workspace, "created.txt"), "round-created\n");
      });
      await writeFile(join(h.workspace, "source.txt"), "manual edit after pause\n");
      await expect(h.engine.withdraw(run.id)).rejects.toThrow();
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("manual edit after pause\n");
      expect(await readFile(join(h.workspace, "created.txt"), "utf8")).toBe("round-created\n");
      expect(h.database.getRun(run.id)?.status).toBe("paused");
    } finally { await h.close(); }
  });

  it("compensates the file restore when the final lifecycle validation or DB commit fails", async () => {
    const h = await fixture();
    try {
      const run = h.spec(); await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "round edits\n"));
      const commit = vi.spyOn(h.database, "withdrawLatestRun").mockImplementation(() => { throw new Error("injected DB failure"); });
      await expect(h.engine.withdraw(run.id)).rejects.toThrow(/DB failure/);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("round edits\n");
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      commit.mockRestore();
      const entered = deferred(), release = deferred(), original = h.review.withdrawalRoot.bind(h.review);
      const rootSpy = vi.spyOn(h.review, "withdrawalRoot").mockImplementation(async id => { entered.resolve(); await release.promise; return original(id); });
      const withdrawal = h.engine.withdraw(run.id);
      await entered.promise;
      const newer = h.spec(); h.database.saveRun(newer, "completed");
      release.resolve();
      await expect(withdrawal).rejects.toThrow(/最新/);
      rootSpy.mockRestore();
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("round edits\n");
      expect(h.database.getRun(run.id)?.status).toBe("paused");
    } finally { await h.close(); }
  });

  it("withdraws the latest main round and all descendants, but refuses a surviving external child workspace", async () => {
    const h = await fixture();
    try {
      const run = h.spec(); await h.pause(run);
      const child = h.spec({ parentRunId: run.id }); h.database.saveRun(child, "completed");
      const grandchild = h.spec({ parentRunId: child.id, sessionId: "other" }); h.database.saveRun(grandchild, "paused");
      expect((await h.engine.withdraw(run.id)).withdrawnRunIds).toEqual([run.id, child.id, grandchild.id]);
      for (const id of [run.id, child.id, grandchild.id]) expect(h.database.getRun(id)).toBeUndefined();
      const second = h.spec(); await h.pause(second);
      const external = join(h.root, "surviving-child"); await mkdir(external); await writeFile(join(external, "edit.txt"), "child edits");
      const otherChild = h.spec({ parentRunId: second.id, workspacePath: external }); h.database.saveRun(otherChild, "completed");
      await expect(h.engine.withdraw(second.id)).rejects.toThrow(/子任务/);
      expect(h.database.getRun(second.id)?.status).toBe("paused");
      expect(await readFile(join(external, "edit.txt"), "utf8")).toBe("child edits");
    } finally { await h.close(); }
  });

  it("does not make a legacy paused round withdrawable without a pre-send snapshot", async () => {
    const h = await fixture();
    try {
      const run = h.spec(); h.database.saveRun(run, "paused");
      await expect(h.engine.withdraw(run.id)).rejects.toThrow();
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("dirty before sending\n");
      h.database.deleteSession("session");
      await expect(h.engine.withdraw(run.id)).rejects.toThrow(/会话/);
    } finally { await h.close(); }
  });

  it("rejects mixed non-Git workspace changes even after the intervening task has completed", async () => {
    const h = await fixture();
    try {
      const first = h.spec();
      await h.pause(first, () => writeFile(join(h.workspace, "source.txt"), "first round edits\n"));
      const other = h.spec({ sessionId: "other" });
      const gate = h.block(other, () => writeFile(join(h.workspace, "other.txt"), "other task edits\n"));
      const result = nextResult(h.engine, other.id);
      h.engine.start(other, h.profile); await gate.entered.promise;
      gate.release.resolve();
      expect((await result).status).toBe("completed");
      await h.engine.waitForSettlement(other.id);
      expect(h.engine.isActive(other.id)).toBe(false);
      await expect(h.engine.withdraw(first.id)).rejects.toThrow();
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("first round edits\n");
      expect(await readFile(join(h.workspace, "other.txt"), "utf8")).toBe("other task edits\n");
      expect(h.database.getRun(first.id)?.status).toBe("paused");
      expect(h.database.getRun(other.id)?.status).toBe("completed");
    } finally { await h.close(); }
  });
});

describe("latest paused human message withdrawal", { timeout: 20_000 }, () => {
  it("withdraws only the new message and its execution, retaining the original transcript and earlier edits", async () => {
    const h = await fixture(undefined, { responseText: (_request, index) => index === 1 ? "Original response retained." : "Accidental response removed." });
    try {
      const run = h.spec({ request: "Keep the original task and its completed work" });
      await h.pause(run, async () => {
        await writeFile(join(h.workspace, "source.txt"), "earlier round changes\n");
        await writeFile(join(h.workspace, "prior.txt"), "keep this prior file\n");
      });
      const before = h.database.getLatestCheckpoint(run.id)!;
      const submitted = await h.steerAndPause(run, "This latest message was sent by mistake", async () => {
        await writeFile(join(h.workspace, "source.txt"), "accidental changes\n");
        await writeFile(join(h.workspace, "new.txt"), "remove this new file\n");
      });
      expect(h.database.listEvents(run.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: submitted.messageId, withdrawable: true }));
      const spent = h.database.getLatestCheckpoint(run.id)!;
      expect(spent.usage.inputTokens).toBeGreaterThan(before.usage.inputTokens);
      expect(spent.turns).toBeGreaterThan(before.turns);
      expect(spent.transcript.some(message => message.steeringId === submitted.messageId)).toBe(true);
      const withdrawn = await h.engine.withdraw(run.id, submitted.messageId);
      expect(withdrawn).toMatchObject({ run: { id: run.id, request: run.request }, withdrawnRunIds: [], messageId: submitted.messageId, text: "This latest message was sent by mistake" });
      expect(h.database.getRun(run.id)).toMatchObject({ status: "paused", spec: { request: run.request, budget: run.budget } });
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier round changes\n");
      expect(await readFile(join(h.workspace, "prior.txt"), "utf8")).toBe("keep this prior file\n");
      await expect(readFile(join(h.workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const restored = h.database.getLatestCheckpoint(run.id)!;
      expect(restored.transcript).toEqual(before.transcript);
      expect(restored.pendingSteering ?? []).toEqual(before.pendingSteering ?? []);
      expect(restored.usage).toEqual(spent.usage);
      expect(restored.turns).toBe(spent.turns);
      expect(restored.toolCalls).toBe(spent.toolCalls);
      expect(restored.elapsedMs).toBeGreaterThanOrEqual(spent.elapsedMs!);
      expect(h.database.listEvents(run.id).some(event => event.type === "steering_submitted" && event.messageId === submitted.messageId)).toBe(false);
      expect(h.database.listEvents(run.id).some(event => event.type === "text_delta" && event.delta.includes("Accidental response"))).toBe(false);
      const requestIndex = h.requests.length;
      const finished = nextResult(h.engine, run.id);
      h.engine.resume(run.id, h.profile);
      expect((await finished).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      expect(h.requests[requestIndex]!.messages.some(message => message.steeringId === submitted.messageId)).toBe(false);
      expect(JSON.stringify(h.requests[requestIndex]!.messages)).not.toContain("This latest message was sent by mistake");
      expect(JSON.stringify(h.requests[requestIndex]!.messages)).not.toContain("Accidental response removed.");
    } finally { await h.close(); }
  });

  it("requires the latest message and a fully settled pause, and prevents a whole-run shortcut", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run);
      const first = await h.steerAndPause(run, "Keep this first correction", () => writeFile(join(h.workspace, "first.txt"), "first correction\n"));
      const gate = h.block(run, () => writeFile(join(h.workspace, "second.txt"), "second correction\n"));
      const result = nextResult(h.engine, run.id);
      const second = await h.engine.steerAndResume(run.id, "Retract this latest correction", h.profile);
      if (!second.accepted) throw new Error("Fixture correction unexpectedly rejected");
      await gate.entered.promise;
      await expect(h.engine.withdraw(run.id, second.messageId)).rejects.toThrow(/暂停/);
      h.engine.pause(run.id);
      gate.release.resolve();
      expect((await result).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      await expect(h.engine.withdraw(run.id, first.messageId)).rejects.toThrow(/最新/);
      await expect(h.engine.withdraw(run.id)).rejects.toThrow();
      await h.engine.withdraw(run.id, second.messageId);
      expect(await readFile(join(h.workspace, "first.txt"), "utf8")).toBe("first correction\n");
      await expect(readFile(join(h.workspace, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.database.listEvents(run.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: first.messageId }));
      expect(h.database.getLatestCheckpoint(run.id)!.transcript.some(message => message.steeringId === first.messageId)).toBe(true);
      await h.engine.withdraw(run.id, first.messageId);
      await expect(readFile(join(h.workspace, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.database.getLatestCheckpoint(run.id)!.transcript.some(message => message.steeringId === first.messageId)).toBe(false);
      // Once every additional human message is gone, the original paused round is the latest
      // visible human boundary again and can use its own original pre-send rollback point.
      await h.engine.withdraw(run.id);
      expect(h.database.getRun(run.id)).toBeUndefined();
    } finally { await h.close(); }
  });

  it("keeps an actual executed tool call charged after restoring its file edits", async () => {
    const entered = deferred(), release = deferred();
    let workspace = "";
    const execute = vi.fn(async () => {
      await writeFile(join(workspace, "source.txt"), "new-message tool edits\n");
      entered.resolve();
      await release.promise;
      return { output: { text: "tool result belonging to the new message" } };
    });
    const tools = new ToolRegistry().register({
      requiresApproval: false,
      contract: { name: "fixture_operation", description: "Local tool budget fixture", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", idempotent: true, timeoutMs: 10_000 },
      execute,
    });
    const h = await fixture(tools, { toolName: "fixture_operation", readToolCallId: (request, index) => `read-${request.runId}-${index}` });
    workspace = h.workspace;
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "earlier work\n"));
      const before = h.database.getLatestCheckpoint(run.id)!;
      expect(before.toolCalls).toBe(0);
      const paused = nextResult(h.engine, run.id);
      const submitted = await h.engine.steerAndResume(run.id, "Accidental tool operation", h.profile);
      if (!submitted.accepted) throw new Error("Fixture correction unexpectedly rejected");
      await Promise.race([entered.promise, paused.then(result => { throw new Error(`Fixture ended before its tool executed: ${result.status}`); })]);
      expect(h.engine.pause(run.id)).toBe(true);
      release.resolve();
      expect((await paused).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      const spent = h.database.getLatestCheckpoint(run.id)!;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(spent.toolCalls).toBeGreaterThan(before.toolCalls);
      expect(spent.usage.inputTokens).toBeGreaterThan(before.usage.inputTokens);
      await h.engine.withdraw(run.id, submitted.messageId);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier work\n");
      const restored = h.database.getLatestCheckpoint(run.id)!;
      expect(restored.transcript).toEqual(before.transcript);
      expect(restored.toolCalls).toBe(spent.toolCalls);
      expect(restored.turns).toBe(spent.turns);
      expect(restored.usage).toEqual(spent.usage);
      expect(JSON.stringify(restored.transcript)).not.toContain("tool result belonging to the new message");
    } finally { release.resolve(); await h.close(); }
  });

  it("rejects completed messages and legacy steering without a pre-message snapshot", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run);
      const finished = nextResult(h.engine, run.id);
      const submitted = await h.engine.steerAndResume(run.id, "A correction that finishes", h.profile);
      if (!submitted.accepted) throw new Error("Fixture correction unexpectedly rejected");
      expect((await finished).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      await expect(h.engine.withdraw(run.id, submitted.messageId)).rejects.toThrow(/暂停/);
      const legacy = h.spec();
      await h.pause(legacy, () => writeFile(join(h.workspace, "source.txt"), "legacy prior work\n"));
      const accepted = h.engine.steer(legacy.id, "Legacy queued human input");
      if (!accepted.accepted) throw new Error("Fixture legacy input unexpectedly rejected");
      await expect(h.engine.withdraw(legacy.id, accepted.messageId)).rejects.toThrow();
      await expect(h.engine.withdraw(legacy.id)).rejects.toThrow();
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("legacy prior work\n");
      expect(h.database.getRun(legacy.id)?.status).toBe("paused");
      expect(h.database.listEvents(legacy.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: accepted.messageId }));
    } finally { await h.close(); }
  });

  it("reverts an accepted message that is still pending after automatic resume fails", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "earlier work\n"));
      const before = h.database.getLatestCheckpoint(run.id)!;
      const resume = vi.spyOn(h.engine, "resume").mockImplementationOnce(() => { throw new Error("injected resume failure"); });
      const accepted = await h.engine.steerAndResume(run.id, "Accepted but not yet delivered", h.profile);
      expect(accepted).toMatchObject({ accepted: true, resumed: false, status: "paused" });
      if (!accepted.accepted) throw new Error("Fixture correction unexpectedly rejected");
      resume.mockRestore();
      expect(h.database.getLatestCheckpoint(run.id)!.pendingSteering).toContainEqual(expect.objectContaining({ id: accepted.messageId }));
      await h.engine.withdraw(run.id, accepted.messageId);
      expect(h.database.getLatestCheckpoint(run.id)!.transcript).toEqual(before.transcript);
      expect(h.database.getLatestCheckpoint(run.id)!.pendingSteering ?? []).toEqual(before.pendingSteering ?? []);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier work\n");
      const done = nextResult(h.engine, run.id);
      h.engine.resume(run.id, h.profile);
      expect((await done).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("Accepted but not yet delivered");
    } finally { await h.close(); }
  });

  it("compensates filesystem rollback if committing a message withdrawal fails, then allows a retry", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "earlier work\n"));
      const submitted = await h.steerAndPause(run, "Accidental filesystem correction", async () => {
        await writeFile(join(h.workspace, "source.txt"), "latest message changes\n");
        await writeFile(join(h.workspace, "new.txt"), "latest new file\n");
      });
      const commit = vi.spyOn(h.database, "withdrawLatestSteering").mockImplementationOnce(() => { throw new Error("injected message DB failure"); });
      await expect(h.engine.withdraw(run.id, submitted.messageId)).rejects.toThrow(/message DB failure/);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("latest message changes\n");
      expect(await readFile(join(h.workspace, "new.txt"), "utf8")).toBe("latest new file\n");
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      expect(h.database.listEvents(run.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: submitted.messageId }));
      commit.mockRestore();
      await h.engine.withdraw(run.id, submitted.messageId);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier work\n");
      await expect(readFile(join(h.workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await h.close(); }
  });

  it("preserves a manual edit after pausing and leaves the latest message visible when rollback conflicts", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "earlier work\n"));
      const submitted = await h.steerAndPause(run, "Latest message with edits", async () => {
        await writeFile(join(h.workspace, "source.txt"), "latest edits\n");
        await writeFile(join(h.workspace, "new.txt"), "latest new file\n");
      });
      await writeFile(join(h.workspace, "source.txt"), "manual edit after the second pause\n");
      await expect(h.engine.withdraw(run.id, submitted.messageId)).rejects.toThrow();
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("manual edit after the second pause\n");
      expect(await readFile(join(h.workspace, "new.txt"), "utf8")).toBe("latest new file\n");
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      expect(h.database.listEvents(run.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: submitted.messageId }));
    } finally { await h.close(); }
  });

  it("allows another send, pause and withdrawal after restoring the latest message", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "prior changes survive both withdrawals\n"));
      for (const index of [1, 2]) {
        const submitted = await h.steerAndPause(run, `Accidental correction ${index}`, () => writeFile(join(h.workspace, "source.txt"), `latest correction ${index}\n`));
        await h.engine.withdraw(run.id, submitted.messageId);
        expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("prior changes survive both withdrawals\n");
        expect(h.database.getRun(run.id)?.status).toBe("paused");
        expect(h.database.getLatestCheckpoint(run.id)!.transcript.some(message => message.steeringId === submitted.messageId)).toBe(false);
      }
      const done = nextResult(h.engine, run.id);
      h.engine.resume(run.id, h.profile);
      expect((await done).status).toBe("completed");
      await h.engine.waitForSettlement(run.id);
      expect(JSON.stringify(h.requests.at(-1)!.messages)).not.toContain("Accidental correction");
    } finally { await h.close(); }
  });

  it("withdraws children created after the new message while preserving earlier child records", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      await h.pause(run);
      const earlier = h.spec({ parentRunId: run.id });
      h.database.saveRun(earlier, "completed");
      const submitted = await h.steerAndPause(run, "Accidental delegation", () => writeFile(join(h.workspace, "child.txt"), "latest child output\n"));
      const child = h.spec({ parentRunId: run.id });
      h.database.saveRun(child, "completed");
      const grandchild = h.spec({ parentRunId: child.id, sessionId: "other" });
      h.database.saveRun(grandchild, "paused");
      const withdrawn = await h.engine.withdraw(run.id, submitted.messageId);
      expect(new Set(withdrawn.withdrawnRunIds)).toEqual(new Set([child.id, grandchild.id]));
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      expect(h.database.getRun(earlier.id)?.status).toBe("completed");
      expect(h.database.getRun(child.id)).toBeUndefined();
      expect(h.database.getRun(grandchild.id)).toBeUndefined();
      await expect(readFile(join(h.workspace, "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await h.close(); }
  });

  it("waits for a pending message snapshot during shutdown and never accepts input after closing", async () => {
    const h = await fixture();
    const entered = deferred(), release = deferred();
    const originalBegin = h.review.beginMessageWithdrawal.bind(h.review);
    const begin = vi.spyOn(h.review, "beginMessageWithdrawal").mockImplementation(async (runId, messageId) => {
      await originalBegin(runId, messageId);
      entered.resolve();
      await release.promise;
    });
    let closing: Promise<void> | undefined;
    try {
      const run = h.spec();
      await h.pause(run, () => writeFile(join(h.workspace, "source.txt"), "earlier work\n"));
      const submitted = h.engine.steerAndResume(run.id, "Must not be accepted after shutdown", h.profile);
      const rejected = expect(submitted).rejects.toThrow(/closed|关闭/);
      await entered.promise;
      let closed = false;
      closing = h.engine.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      release.resolve();
      await rejected;
      await closing;
      expect(h.database.listEvents(run.id).some(event => event.type === "steering_submitted")).toBe(false);
      expect(h.database.getLatestCheckpoint(run.id)!.pendingSteering ?? []).toEqual([]);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier work\n");
    } finally { release.resolve(); await closing; begin.mockRestore(); await h.close(); }
  });

  it("captures a withdrawable message boundary after an in-flight pause finishes, preserving late earlier work", async () => {
    const h = await fixture();
    try {
      const run = h.spec();
      const originalGate = h.block(run), originalPaused = nextResult(h.engine, run.id);
      h.engine.start(run, h.profile);
      await originalGate.entered.promise;
      expect(h.engine.pause(run.id)).toBe(true);
      expect(h.database.getRun(run.id)?.status).not.toBe("paused");
      const latestGate = h.block(run, async () => {
        await writeFile(join(h.workspace, "source.txt"), "accidental new-message edits\n");
        await writeFile(join(h.workspace, "new.txt"), "accidental new file\n");
      });
      let submitted = false;
      const pendingSubmission = h.engine.steerAndResume(run.id, "Sent immediately after pressing pause", h.profile).then(result => { submitted = true; return result; });
      await Promise.resolve();
      expect(submitted).toBe(false);
      expect(h.database.listEvents(run.id).some(event => event.type === "steering_submitted")).toBe(false);
      // The previous provider/tool may finish a write after the pause request. It belongs to the
      // earlier execution and must be frozen before assigning the additional human boundary.
      await writeFile(join(h.workspace, "source.txt"), "earlier work finished after pause request\n");
      await writeFile(join(h.workspace, "prior.txt"), "late earlier file\n");
      originalGate.release.resolve();
      expect((await originalPaused).status).toBe("paused");
      const accepted = await pendingSubmission;
      expect(accepted).toMatchObject({ accepted: true, resumed: true });
      if (!accepted.accepted) throw new Error("Fixture correction unexpectedly rejected");
      await latestGate.entered.promise;
      const latestPaused = nextResult(h.engine, run.id);
      h.engine.pause(run.id);
      latestGate.release.resolve();
      expect((await latestPaused).status).toBe("paused");
      await h.engine.waitForSettlement(run.id);
      expect(h.database.listEvents(run.id)).toContainEqual(expect.objectContaining({ type: "steering_submitted", messageId: accepted.messageId, withdrawable: true }));
      await h.engine.withdraw(run.id, accepted.messageId);
      expect(await readFile(join(h.workspace, "source.txt"), "utf8")).toBe("earlier work finished after pause request\n");
      expect(await readFile(join(h.workspace, "prior.txt"), "utf8")).toBe("late earlier file\n");
      await expect(readFile(join(h.workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.database.getRun(run.id)?.status).toBe("paused");
      expect(h.database.getLatestCheckpoint(run.id)!.transcript.some(message => message.steeringId === accepted.messageId)).toBe(false);
    } finally { await h.close(); }
  });
});
