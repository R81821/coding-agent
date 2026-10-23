import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, nowIso, type RunSpec, type VerificationRun } from "@harness/protocol";
import type { ToolDefinition } from "@harness/tools";
import { AGENTS_MD_TEMPLATE, LEGACY_AGENTS_MD_TEMPLATE, buildInitialMessages, memoryScopeWarning } from "../packages/core/src/context.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";
import { ProjectTrustService, projectInstructionMigration, knowledgeFingerprint } from "../packages/core/src/project-trust.js";
import { PermissionEngine } from "../packages/core/src/security.js";
import { toHarnessMessages } from "../packages/core/src/pi-agent-bridge.js";
import { diagnoseRequest } from "../packages/core/src/model-request.js";
import { descriptor } from "@harness/providers";

const writer: ToolDefinition = { contract: { name: "patch", description: "patch", risk: "write", inputSchema: {}, idempotent: false, timeoutMs: 1000 }, async execute() { return { output: {} }; } };
const terminal: ToolDefinition = { ...writer, contract: { ...writer.contract, name: "terminal", risk: "high" } };
const spec: RunSpec = { id: "fixture", sessionId: "fixture", request: "分析如何实现，不修改", taskMode: "auto", workflowVersion: 3, workspacePath: "D:/unrelated-python", profileId: DEFAULT_PROFILE.id, attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt: nowIso() };
const fresh = (mode: "auto" | "analysis" | "change" = "auto") => new SequentialWorkflow(spec.request, () => {}, undefined, {}, mode);
function observe(workflow: SequentialWorkflow, name = "read_file", id = "source") { workflow.observe({ id, name, input: { path: "value.ts" } }, { output: "complete content" }); }
function accept(workflow: SequentialWorkflow, verificationIds: string[] = []) {
  workflow.acceptRequirements(workflow.state.requirementIds.map(requirementId => ({ requirementId, summary: "Reviewed the requested content and current complete diff", observationIds: ["diff"], diffObservationId: "diff", verificationIds, passed: true })));
}
function verify(workflow: SequentialWorkflow, stage: "local" | "broader" = "local") {
  const run: VerificationRun = { id: `verify-${stage}`, runId: "fixture", attempt: 0, epoch: workflow.state.epoch, revision: workflow.state.revision, stage,
    passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(), results: [{ itemId: "test", command: "node --test value.test.mjs", cwd: ".", exitCode: 0, passed: true, required: true, output: "passed", timedOut: false, durationMs: 1 }] };
  workflow.recordVerification(run);
  return run.id;
}

describe("behavior policy 2 task boundaries", () => {
  it("keeps conditional implementation references from imposing work on automatic consultation", () => {
    for (const request of [spec.request, "这张截图如何实现", "比较两种架构", "运行指定测试并报告结果"]) {
      const messages = buildInitialMessages({ run: { ...spec, request }, profile: DEFAULT_PROFILE, memories: [] });
      const policy = messages.filter(message => message.role === "system").flatMap(message => message.content).map(part => part.type === "text" ? part.text : "").join("\n");
      expect(policy).toContain("Implementation and task-graph guidance below is conditional reference, not a request to change files");
      expect(policy).toContain("Pure consultation, implementation plans, read-only investigation, and explicitly requested test runs do not require a task graph, source edits, or unrelated verification");
      expect(policy).toContain("use graph guidance only for complex implementation or an existing accepted graph");
      expect(policy).not.toContain("Test failures and stale evidence are work for the repair loop");
      expect(policy).toContain("Do not scan unrelated code or run unrelated tests");
      expect(messages.at(-1)?.content[0]).toMatchObject({ text: request, trust: "user_request" });
    }
  });
  it("does not treat terminal risk or a denied patch attempt as an actual modification", () => {
    const w = fresh();
    expect(w.before({ id: "read", name: "terminal", input: { command: "Get-Content value.ts" } }, terminal)).toBeUndefined();
    expect(w.before({ id: "write", name: "patch", input: {} }, writer)).toBeUndefined();
    expect(w.needsChange).toBe(false);
    expect(new PermissionEngine().decide("patch", {}, "write", [], spec.workspacePath).allowed).toBe(false);
    expect(w.state.revision).toBe(0);
    w.applyEffect({ kind: "read", changedFiles: [] });
    expect(w.checksCurrent()).toBe(true);
    expect(w.projection().completionBlockers).toEqual([]);
  });
  it("retains explicit analysis restrictions before execution", () => {
    const w = fresh("analysis");
    expect(w.before({ id: "patch", name: "patch", input: {} }, writer)).toContain("analysis_mode_read_only");
    expect(w.before({ id: "shell", name: "terminal", input: { command: "Set-Content value.ts changed" } }, terminal)).toContain("analysis_mode_read_only");
    expect(() => w.advance({ action: "understand", summary: "modify", requirements: ["modify"] })).toThrow(/Analysis/);
  });
  it("planning by itself is not implementation, but starting planned work has real gates", () => {
    const w = fresh(); observe(w);
    w.advance({ action: "configure", summary: "Proposed design", architecture: "Existing module", evidenceIds: ["source"], requirements: ["Explain design"], steps: [{ id: "a", text: "Potential change", verification: [{ command: "node --test value.test.mjs" }] }], integration: [{ command: "node --test integration.test.mjs" }] });
    expect(w.needsChange).toBe(false);
    expect(w.checksCurrent()).toBe(true);
    w.advance({ action: "start_step", stepId: "a" });
    expect(w.needsChange).toBe(true);
    expect(w.checksCurrent()).toBe(false);
  });
  it("actual shell writes use lightweight verification and cannot complete with only prose", () => {
    const w = fresh();
    w.applyEffect({ kind: "repository_write", changedFiles: ["value.ts"] });
    expect(w.needsChange).toBe(true);
    expect(w.state.revision).toBe(1);
    expect(w.verificationGate("local")).toBeUndefined();
    observe(w, "workspace_diff", "early-diff");
    expect(() => accept(w)).toThrow();
    const id = verify(w);
    observe(w, "workspace_diff", "diff");
    accept(w, [id]); w.acceptFinalReport("Changed and tested.");
    expect(w.canFinish()).toBe(true);
    expect(w.state.sequential?.steps).toEqual([]);
  });
  it("keeps unknown effects sticky across reads and empty test claims", () => {
    const w = fresh(); w.applyEffect({ kind: "unknown", changedFiles: [] });
    w.applyEffect({ kind: "read", changedFiles: [] });
    observe(w, "workspace_diff", "diff");
    expect(w.state.effect).toBe("unknown");
    expect(() => accept(w)).toThrow(/unverified execution effect/);
    w.acceptFinalReport("No change"); expect(w.canFinish()).toBe(false);
  });
  it("one authorization or database file still requires broader checks", () => {
    for (const file of ["auth.ts", "db/migration.sql", "storage.ts", "permission.ts"]) {
      const w = fresh(); w.applyEffect({ kind: "repository_write", changedFiles: [file] });
      verify(w); expect(w.checksCurrent()).toBe(false);
      verify(w, "broader"); expect(w.checksCurrent()).toBe(true);
    }
  });
  it("plain documents require current diff acceptance but no unrelated code tests", () => {
    const w = fresh(); w.applyEffect({ kind: "repository_write", changedFiles: ["docs/design.md"] });
    expect(w.requiresCodeChecks).toBe(false);
    expect(() => accept(w)).toThrow();
    observe(w, "workspace_diff", "diff"); accept(w); w.acceptFinalReport("Design delivered; content and links reviewed.");
    expect(w.canFinish()).toBe(true);
    for (const file of ["requirements.txt", "CMakeLists.txt", "style.css"]) {
      const other = fresh(); other.applyEffect({ kind: "repository_write", changedFiles: [file] });
      expect(other.requiresCodeChecks).toBe(true);
    }
  });
  it("preserves configured checks for documents and changed tasks on recovery", () => {
    const w = new SequentialWorkflow("Doc", () => {}, undefined, { items: [{ required: true }] });
    w.applyEffect({ kind: "repository_write", changedFiles: ["README.md"] });
    expect(w.requiresCodeChecks).toBe(true);
    const restored = new SequentialWorkflow("Resume", () => {}, w.snapshot());
    expect(restored.needsChange).toBe(true);
    expect(restored.state.revision).toBe(1);
    const highImpact = fresh(); highImpact.applyEffect({ kind: "repository_write", changedFiles: ["auth.ts"] });
    expect(new SequentialWorkflow("Resume", () => {}, highImpact.snapshot()).state.broaderPolicy).toBe("required");
    expect(restored.state.requirements).toEqual(w.state.requirements);
    const legacy = w.snapshot(); delete legacy.behaviorPolicyVersion;
    expect(new SequentialWorkflow("Resume", () => {}, legacy).state.behaviorPolicyVersion).toBe(1);
  });
  it("surfaces overbroad approved memory scope without rewriting the record", () => {
    const memory = { id: "approved", content: "每次任务都运行所有测试", scope: "global", source: "user", status: "approved" } as never;
    const before = JSON.stringify(memory);
    expect(memoryScopeWarning(memory)).toContain("Scope review for approved memory approved");
    expect(JSON.stringify(memory)).toBe(before);
    const messages = buildInitialMessages({ run: spec, profile: DEFAULT_PROFILE, memories: [memory] });
    expect(JSON.stringify(messages)).toContain("每次任务都运行所有测试");
    expect(JSON.stringify(messages)).toContain("specific conflict");
  });
  it("preserves native system/developer roles instead of promoting the profile to system policy", () => {
    const initial = buildInitialMessages({ run: spec, profile: { ...DEFAULT_PROFILE, systemPrompt: "PROFILE_SENTINEL" }, memories: [] });
    const translated = toHarnessMessages({ systemPrompt: "old flattened prompt", messages: [] }, [], initial);
    expect(translated.find(message => message.role === "developer")?.content[0]).toMatchObject({ text: "PROFILE_SENTINEL", trust: "user_profile" });
    expect(JSON.stringify(translated.filter(message => message.role === "system"))).not.toContain("PROFILE_SENTINEL");
    expect(JSON.stringify(translated)).not.toContain("old flattened prompt");
    const diagnostic = diagnoseRequest({ runId: "fixture", model: descriptor({ providerId: "fake", modelId: "actual-id", displayName: "display", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } }), messages: initial, tools: [], maxOutputTokens: 1000, parallelToolCalls: false, store: false });
    expect(diagnostic).toMatchObject({ boundary: "provider_request", modelId: "actual-id", toolCount: 0 });
    expect(JSON.stringify(diagnostic)).not.toContain("PROFILE_SENTINEL");
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { const child = relative(tmpdir(), root); if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); } });
describe("exact project instruction migration", () => {
  it("preserves custom rules and managed memory, rejects stale previews and requires new trust", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-policy-migration-")); roots.push(root);
    const records = new Map<string, unknown>();
    const service = new ProjectTrustService({ saveProjectTrust: (path, value) => records.set(path, value), getProjectTrust: <T>(path: string) => records.get(path) as T | undefined });
    const suffix = "\n<!-- harness-memory:start -->\nUse Chinese\n<!-- harness-memory:end -->\n";
    await writeFile(join(root, "AGENTS.md"), LEGACY_AGENTS_MD_TEMPLATE + suffix);
    const before = await service.inspect(root); expect(before.migration).toBeDefined();
    service.trust(root, before.files);
    const migrated = await service.migrate(root, before.migration!.fromSha256);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(suffix);
    expect(await service.loadInstructions(root)).toBeUndefined();
    service.trust(root, [migrated]); expect(await service.loadInstructions(root)).toContain("纯咨询");
    await expect(service.migrate(root, before.migration!.fromSha256)).rejects.toThrow(/变化/);
    expect(projectInstructionMigration(LEGACY_AGENTS_MD_TEMPLATE + "\nHandwritten rule\n")).toBeUndefined();
    expect(projectInstructionMigration(LEGACY_AGENTS_MD_TEMPLATE.replace("## 验证", "## Custom"))).toBeUndefined();
    expect(projectInstructionMigration(LEGACY_AGENTS_MD_TEMPLATE.replaceAll("\n", "\r\n"))).toBe(AGENTS_MD_TEMPLATE);
  });
  it("keeps managed memory invalidation after migration and explicit re-trust", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-policy-memory-migration-")); roots.push(root);
    const records = new Map<string, unknown>();
    let memories = [{ id: "preference", content: "Use Chinese", status: "approved", scope: "project", scopeId: root }] as never[];
    const service = new ProjectTrustService({ saveProjectTrust: (path, value) => records.set(path, value), getProjectTrust: <T>(path: string) => records.get(path) as T | undefined, listMemories: () => memories });
    await writeFile(join(root, "AGENTS.md"), LEGACY_AGENTS_MD_TEMPLATE + "\n<!-- harness-memory:start -->\nUse Chinese\n<!-- harness-memory:end -->\n");
    const before = await service.inspect(root);
    service.trust(root, before.files.map(({ path, sha256 }) => ({ path, sha256 })), [{ id: "preference", hash: knowledgeFingerprint(memories[0]!) }]);
    const migrated = await service.migrate(root, before.migration!.fromSha256);
    expect(await service.loadInstructions(root)).toBeUndefined();
    service.trust(root, [migrated]);
    expect(await service.loadInstructions(root)).toContain("Use Chinese");
    memories = [];
    expect(await service.loadInstructions(root)).not.toContain("Use Chinese");
  });
});
