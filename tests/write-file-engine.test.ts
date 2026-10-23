import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type Profile, type RunSpec, type VerificationRun, type WorkflowState } from "@harness/protocol";
import { createDefaultToolRegistry } from "@harness/tools";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";

const initial = "export const value = 1;\n";
const revised = "export const value = 2;\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.each([2, 3] as const)("real write_file through workflow %s", workflowVersion => {
  it("authorizes the path, records real diffs, advances only actual changes and rejects a stale overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-write-file-engine-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const vault = await VaultCrypto.open(join(root, "key.json"), "write-file-engine-test-password");
    const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
    const model = descriptor({ providerId: "file-fixture", modelId: "file-fixture", displayName: "File fixture", maxContextTokens: 128000 });
    const events: AgentEvent[] = [];
    const receipts: Array<{ event: Extract<AgentEvent, { type: "tool_finished" }>; revision: number }> = [];
    let latest: WorkflowState | undefined;
    let turn = 0;
    const operations = [{ path: "source.ts", content: initial },
      { path: "source.ts", content: revised, overwrite: true, expectedSha256: hash(initial) },
      { path: "source.ts", content: "stale replacement\n", overwrite: true, expectedSha256: hash(initial) }];
    const provider: ModelProvider = { id: model.providerId, listModels: async () => [model], health: async () => true, estimateCost: () => 0,
      async *stream(request) {
        expect(request.tools?.some(tool => tool.name === "write_file")).toBe(true);
        const operation = operations[turn++];
        if (!operation) { engine.cancel(request.runId); return; }
        yield { type: "tool_call", toolCall: { id: `write-${turn}`, name: "write_file", input: operation } };
      } };
    const engine = new HarnessEngine({ database, providers: [provider], tools: createDefaultToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [provider.id], toolNames: ["write_file", "read_file"], memoryScopes: [], generationPolicy: { maxOutputTokens: 1024 } };
    const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Create source.ts and update its value, checking the stale-write boundary", workflowVersion, taskMode: "auto", workspacePath: workspace, profileId: profile.id, attachments: [], grants: [], createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 8, maxDurationMs: 15000 } };
    engine.on("event", (event: AgentEvent) => {
      if (event.runId !== spec.id) return;
      events.push(event);
      if (event.type === "workflow_updated") latest = event.workflow;
      if (event.type === "approval_required") setTimeout(() => engine.approvals.decide(event.approvalId, true, "test:user"), 0);
      if (event.type === "tool_finished" && event.callId.startsWith("write-")) receipts.push({ event, revision: latest?.revision ?? -1 });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Write-file engine fixture timed out")); }, 20000);
        engine.on("event", (event: AgentEvent) => { if (event.runId === spec.id && event.type === "result") { clearTimeout(timer); resolve(); } });
        engine.start(spec, profile);
      });
      await engine.waitForSettlement(spec.id);
      expect(receipts).toHaveLength(3);
      expect(receipts.map(item => item.revision)).toEqual([1, 2, 2]);
      expect(receipts[0]?.event).toMatchObject({ isError: false, output: { written: true, created: true, path: "source.ts", sha256: hash(initial), added: 1, deleted: 0 } });
      expect(receipts[1]?.event).toMatchObject({ isError: false, output: { written: true, created: false, sha256: hash(revised), added: 1, deleted: 1 } });
      expect(receipts[2]?.event).toMatchObject({ isError: true, output: { written: false, phase: "validation" } });
      expect(receipts[2]?.event.output).not.toHaveProperty("diff");
      expect(await readFile(join(workspace, "source.ts"), "utf8")).toBe(revised);
      expect(events.filter(event => event.type === "approval_required")).toHaveLength(1);
      expect(events.filter(event => event.type === "plan_approval_required")).toEqual([]);
      expect(database.getRun(spec.id)?.spec.grants).toEqual(expect.arrayContaining([expect.objectContaining({ toolNames: ["write_file"], exactPathInputs: { path: "source.ts", filePath: null, cwd: null } })]));
      expect(latest?.changedFiles).toEqual(["source.ts"]);
    } finally {
      await engine.close(); database.close(); vault.dispose();
      const withinTemp = relative(tmpdir(), root);
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});

describe("write validation and current test receipts", () => {
  it.each(["validation", "write", "unknown"])("preserves receipts only for a confirmed no-change validation failure (%s)", mode => {
    const workflow = new LightweightWorkflow("Update source.ts", () => {});
    workflow.applyEffect({ kind: "repository_write", changedFiles: ["source.ts"] });
    const run: VerificationRun = { id: "tests", runId: "run", attempt: 0, epoch: workflow.state.epoch, revision: workflow.state.revision,
      stage: "local", passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(), results: [{ itemId: "unit", command: "node --test source.test.mjs", cwd: ".", required: true, passed: true, exitCode: 0, timedOut: false, output: "passed", durationMs: 1 }] };
    workflow.recordVerification(run);
    expect(workflow.checksCurrent()).toBe(true);
    workflow.applyEffect({ kind: mode === "unknown" ? "unknown" : "read", changedFiles: [] });
    workflow.observe({ id: "rejected-write", name: "write_file", input: { path: "source.ts", content: "stale" } }, { isError: true, output: { written: false, phase: mode === "write" ? "write" : "validation" } });
    expect(workflow.state.revision).toBe(1);
    expect(workflow.checksCurrent()).toBe(mode === "validation");
  });
});
