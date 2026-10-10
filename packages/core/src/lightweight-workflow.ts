import { RequirementEvidenceSchema, RequirementReceiptSchema, type ToolCall, type WorkflowState, type VerificationRun } from "@harness/protocol";
import type { z } from "zod";
import type { ToolDefinition, ToolResult } from "@harness/tools";
import { CodingWorkflow } from "./coding-workflow.js";
import type { ExecutionEffect } from "./workspace-impact.js";

const readOnlyGitQuery = /^(?:git status --short|git diff --no-ext-diff|git log -5 --oneline|git rev-parse --show-toplevel)$/;
const readTools = new Set(["read_file", "list_files", "search_text", "search_files", "read_range", "search_symbol", "repository_map", "find_references", "git_diff", "workspace_diff"]);
/** The only terminal commands analysis mode trusts. */
function isReadOnlyGitQuery(call: ToolCall): boolean {
  return call.name === "terminal" && call.input.stdin === undefined && readOnlyGitQuery.test(String(call.input.command).trim());
}

/** Runtime-owned gates; todo status is never acceptance evidence. */
export class LightweightWorkflow extends CodingWorkflow {
  private readonly currentVerificationRuns = new Map<string, { stage: "local" | "broader"; epoch: string; revision: number; codeFingerprint?: string }>();
  private nonInvalidatingToolFailure = false;
  constructor(objective: string, publish: (state: WorkflowState, detail: string) => void, recovered?: WorkflowState, policy: ConstructorParameters<typeof CodingWorkflow>[3] = {}, taskMode: "auto" | "analysis" | "change" = "auto") {
    super(objective, publish, recovered, policy);
    this.state.schemaVersion = 3;
    this.state.taskMode = taskMode;
    this.state.todos ??= [];
    this.state.intent = taskMode === "change" || this.state.revision > 0 ? "change" : "analysis";
    const requirements = objective.split(/\n+/).map(line => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim()).filter(Boolean);
    this.state.requirements = requirements.length > 1 ? requirements : [objective];
    this.state.requirementIds = this.state.requirements.map((_, index) => `req-${index + 1}`);
  }
  override before(call: ToolCall, tool: ToolDefinition): string | undefined {
    if (this.state.taskMode !== "analysis") return;
    const risk = tool.assessRisk?.(call.input) ?? tool.contract.risk;
    if (risk === "read") return;
    // Analysis probes execute in a container with a read-only repository mount and a tmpfs.
    // Destructive commands, raw terminal commands and repository writes keep the original policy.
    if (call.name === "probe" && risk !== "destructive") return;
    if (isReadOnlyGitQuery(call)) return;
    return "analysis_mode_read_only: use read_file/search_files/git_diff or the probe tool; repository writes require auto/change mode.";
  }
  override starting(_call?: ToolCall, _tool?: ToolDefinition): void { /* Content effects determine revisions after execution. */ }
  override invalidate(): void {
    super.invalidate();
    this.currentVerificationRuns?.clear();
  }
  protected clearRequirementAcceptance(): void {
    this.state.requirementsRevision = -1;
    this.state.reviewedRevision = -1;
    this.state.requirementReceipts = [];
    this.state.requirementEvidence = [];
    this.state.review = "";
    this.state.reviewEvidenceIds = [];
  }
  private registerVerificationRun(run: VerificationRun): void {
    this.currentVerificationRuns.delete(run.id);
    const outcome = run.outcome ?? (run.passed ? "passed" : "failed");
    if (run.epoch === this.state.epoch && run.revision === this.state.revision && outcome === "passed" && run.passed && run.results.length > 0 && run.results.some(item => item.required && item.passed) && run.results.every(item => !item.required || (item.passed && !item.timedOut))) {
      this.currentVerificationRuns.set(run.id, { stage: run.stage ?? "local", epoch: run.epoch, revision: run.revision, ...(run.codeFingerprint?.trim() ? { codeFingerprint: run.codeFingerprint } : {}) });
    }
  }
  /** Reuse real persisted test receipts only when the engine has verified the workspace fingerprint. */
  restoreVerificationRuns(runs: VerificationRun[]): void {
    this.currentVerificationRuns.clear();
    this.clearRequirementAcceptance();
    this.skipIndependentReview();
    for (const run of runs) this.registerVerificationRun(run);
    for (const stage of ["local", "broader"] as const) {
      const check = stage === "local" ? this.state.localCheck : this.state.broaderCheck;
      if (check.status === "passed" && (!this.currentVerificationRuns.has(check.runId) || this.currentVerificationRuns.get(check.runId)?.stage !== stage)) {
        check.status = "pending";
        check.reason = "保存的通过状态缺少当前真实测试记录；优化或补充测试后重新运行套件。";
        if (stage === "local") this.state.localRevision = -1; else this.state.broaderRevision = -1;
        this.state.diffRevision = -1;
      }
    }
  }
  applyEffect(effect: ExecutionEffect): void {
    if (effect.kind === "unknown") {
      this.state.effect = "unknown";
      this.invalidate();
      this.move("inspect_result", "执行影响未确认；先用 git status/git diff 复查工作区，再继续或报告。");
      return;
    }
    if (effect.kind === "probe") {
      // An isolated probe is neither a read nor a repository write: record it as such so the run can
      // tell an experiment apart from an inspection, and never let a probe bump the repository
      // revision. Its artifacts live outside the workspace, so they cannot look like a change.
      if (this.state.effect !== "unknown") this.state.effect = "probe";
      return;
    }
    if (effect.kind !== "repository_write") {
      // An unconfirmed effect is sticky: an ordinary read must never clear it. Only a confirmed
      // write (below) or the engine's complete stable repository inspection resolves it.
      if (this.state.effect !== "unknown") this.state.effect = "read";
      return;
    }
    this.state.effect = "repository_write";
    this.state.intent = "change";
    this.state.revision++;
    this.state.changedFiles = [...new Set([...this.state.changedFiles, ...effect.changedFiles])];
    this.invalidate();
    if (this.state.changedFiles.length > 3 || effect.changedFiles.some(path => /auth|security|migration|schema/i.test(path))) this.state.riskFlags = [...new Set([...this.state.riskFlags, "significant_change"])];
    this.move("small_edit", `实际修改 ${effect.changedFiles.length} 个文件；版本 ${this.state.revision}`);
  }
  override observe(call: ToolCall, result: ToolResult): void {
    if (["todo", "read_evidence", "run_verification", "check_requirements"].includes(call.name)) return;
    const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : undefined;
    const validationFailure = ["patch", "apply_patch"].includes(call.name) && output?.applied === false && output.phase === "validation" && this.state.effect !== "repository_write";
    this.nonInvalidatingToolFailure = result.isError === true && this.state.effect !== "unknown" &&
      (readTools.has(call.name) || isReadOnlyGitQuery(call) || validationFailure);
    try { super.observe(call, result); }
    finally { this.nonInvalidatingToolFailure = false; }
    if (!this.needsChange) this.state.diagnosisRequired = false;
  }
  override fail(reason: string, source = "workflow", origin?: WorkflowState["observations"][number]): void {
    if (this.nonInvalidatingToolFailure && origin) {
      this.clearRequirementAcceptance();
      this.recordFailure(reason, source, origin);
      this.move("inspect_result", "读取或补丁校验失败；修正请求后继续，当前真实测试结果仍有效。");
    } else super.fail(reason, source, origin);
    this.state.diagnosisRequired = false;
  }
  /** Only runtime may attach a workspace fingerprint to a complete diff it actually read. */
  bindObservationFingerprint(id: string, fingerprint: string): void {
    if (!fingerprint.trim()) return;
    const observation = this.state.observations.find(item => item.id === id);
    if (observation && ["git_diff", "workspace_diff"].includes(observation.tool) && observation.complete && !observation.failed && observation.epoch === this.state.epoch && observation.revision === this.state.revision) observation.codeFingerprint = fingerprint;
  }
  override recordVerification(run: VerificationRun): void {
    if ((!run.epoch || run.epoch === this.state.epoch) && (run.revision === undefined || run.revision === this.state.revision)) this.clearRequirementAcceptance();
    if (run.results.some(item => item.output.startsWith("verification_config_missing"))) {
      const check = { status: "pending" as const, revision: this.state.revision, epoch: this.state.epoch, runId: run.id, reason: "缺少验证配置" };
      if (run.stage === "broader") this.state.broaderCheck = check; else this.state.localCheck = check;
      return;
    }
    if (!this.needsChange && !run.passed) { this.move("inspect_result", "探针失败；可修复或说明未验证范围"); return; }
    super.recordVerification(run);
    const observation = this.state.observations.find(item => item.id === run.id && item.kind === "verification" && item.epoch === this.state.epoch && item.revision === this.state.revision);
    if (observation && run.codeFingerprint?.trim()) observation.codeFingerprint = run.codeFingerprint;
    this.registerVerificationRun(run);
    this.state.diagnosisRequired = false;
  }
  override checksCurrent(): boolean {
    if (this.state.effect === "unknown") return false;
    if (!this.needsChange) return true;
    const current = (check: WorkflowState["localCheck"]) => check.epoch === this.state.epoch && check.revision === this.state.revision;
    return current(this.state.localCheck) && this.state.localCheck.status === "passed" &&
      (this.state.broaderPolicy !== "required" || (current(this.state.broaderCheck) && this.state.broaderCheck.status === "passed"));
  }
  override missingVerificationStages(): ("local" | "broader")[] {
    return this.needsChange ? super.missingVerificationStages() : [];
  }
  override get requiresIndependentReview(): boolean { return false; }
  /** The runtime calls this before parsing an explicit check_requirements request. */
  beginRequirementAcceptance(): void {
    this.state.explicitRequirementAcceptance = true;
    this.clearRequirementAcceptance();
  }
  acceptRequirements(receipts: Array<z.infer<typeof RequirementReceiptSchema> & { passed: boolean }>): void {
    // Invalid or rejected acceptance must never leave a previous report stamped as complete.
    this.beginRequirementAcceptance();
    if (!this.checksCurrent() || (this.needsChange && this.state.diffRevision !== this.state.revision)) throw new Error(this.needsChange ? "Run the current local and required broader test suites and provide a complete current workspace_diff before check_requirements." : "Confirm the unverified execution effect with a complete stable runtime workspace inspection before read-only acceptance.");
    if (receipts.length !== this.state.requirementIds.length || new Set(receipts.map(item => item.requirementId)).size !== this.state.requirementIds.length || receipts.some(item => !this.state.requirementIds.includes(item.requirementId))) throw new Error("Provide every stable requirementId exactly once.");
    const currentDiff = this.state.observations.findLast(item => ["git_diff", "workspace_diff"].includes(item.tool) && !item.failed && item.complete && item.epoch === this.state.epoch && item.revision === this.state.revision);
    for (const item of receipts) {
      (this.needsChange ? RequirementReceiptSchema : RequirementEvidenceSchema).parse(item);
      if (!item.passed) throw new Error(`${item.requirementId} has not passed acceptance: ${item.summary}`);
      this.freshEvidence(item.observationIds);
      const diff = item.diffObservationId ? this.freshEvidence([item.diffObservationId])[0] : undefined;
      if ((this.needsChange || item.diffObservationId) && (!diff || !["git_diff", "workspace_diff"].includes(diff.tool) ||
        (diff.id !== currentDiff?.id && !(diff.codeFingerprint && diff.codeFingerprint === currentDiff?.codeFingerprint)))) throw new Error(`${item.requirementId} must cite the latest complete current diff observation or a complete diff with the same runtime workspace fingerprint.`);
      const checks = [this.state.localCheck, this.state.broaderCheck];
      for (const id of item.verificationIds) {
        const receipt = this.currentVerificationRuns.get(id);
        const observation = this.freshEvidence([id])[0];
        if (!receipt || receipt.epoch !== this.state.epoch || receipt.revision !== this.state.revision || observation?.kind !== "verification" || !checks.some(check => check.runId === id && check.status === "passed" && check.epoch === this.state.epoch && check.revision === this.state.revision)) throw new Error("Unknown, failed, skipped, empty or stale runtime verification reference: " + id);
        const sameFingerprint = !!diff?.codeFingerprint && diff.codeFingerprint === receipt.codeFingerprint && observation.codeFingerprint === receipt.codeFingerprint;
        if (diff?.codeFingerprint && receipt.codeFingerprint && diff.codeFingerprint !== receipt.codeFingerprint) throw new Error(`${item.requirementId} diff and passing test suites have different runtime workspace fingerprints.`);
        if (diff && !sameFingerprint && diff.sequence <= observation.sequence) throw new Error(`${item.requirementId} must cite a fresh complete diff read after its passing test suites when matching runtime workspace fingerprints are unavailable.`);
      }
      if (this.needsChange && (!item.verificationIds.includes(this.state.localCheck.runId) || (this.state.broaderPolicy === "required" && !item.verificationIds.includes(this.state.broaderCheck.runId)))) throw new Error(`${item.requirementId} must cite current passing local and required broader runtime test receipts.`);
    }
    this.state.requirementReceipts = receipts.map(({ passed: _passed, ...receipt }) => receipt);
    this.state.requirementEvidence = receipts.map(item => item.summary);
    this.state.requirementsRevision = this.state.revision;
    this.move("requirements_check", this.needsChange ? "实际测试与当前证据已逐项完成需求验收；提交最终报告" : "当前只读证据已逐项完成需求验收；提交最终报告");
  }
  acceptFinalReport(text: string): void {
    if (!text.trim() || !this.checksCurrent() || (this.needsChange && this.state.diffRevision !== this.state.revision)) return;
    const evidence = this.state.observations.filter(o => !o.failed && o.complete && o.epoch === this.state.epoch && o.revision === this.state.revision);
    if (!evidence.length) return;
    const diff = evidence.findLast(o => ["git_diff", "workspace_diff"].includes(o.tool) && o.revision === this.state.revision);
    if ((this.needsChange || this.state.explicitRequirementAcceptance) && (this.state.requirementsRevision !== this.state.revision || this.state.requirementReceipts.length !== this.state.requirementIds.length)) return;
    this.state.requirementsRevision = this.state.revision;
    this.state.reviewedRevision = this.state.revision;
    this.state.review = text.slice(0, 3000);
    this.state.reviewEvidenceIds = diff ? [diff.id] : [evidence.at(-1)!.id];
    if (!this.needsChange && !this.state.explicitRequirementAcceptance) this.state.requirementReceipts = this.state.requirementIds.map(requirementId => ({ requirementId, summary: "Read-only report: " + text.slice(0, 2400), observationIds: this.state.reviewEvidenceIds, verificationIds: [this.state.localCheck.runId, this.state.broaderCheck.runId].filter(Boolean), diffObservationId: diff?.id ?? "" }));
    this.skipIndependentReview();
  }
  override baseCanFinish(): boolean {
    return this.checksCurrent() && (!this.needsChange || this.state.diffRevision === this.state.revision) && this.state.requirementsRevision === this.state.revision && this.state.reviewedRevision === this.state.revision && !!this.state.review && this.state.requirementReceipts.length === this.state.requirements.length;
  }
  protected override rejectIndependentReview(summary: string): void {
    // A rejected report does not change the code or erase observed passing checks. Actual edits,
    // execution failures and unconfirmed workspace effects still use the full invalidation path.
    this.state.requirementsRevision = -1;
    this.state.reviewedRevision = -1;
    this.state.requirementEvidence = [];
    this.state.review = "";
    this.state.diagnosisRequired = false;
    this.recordFailure(summary, "independent-review");
  }
  override recordIndependentReview(passed: boolean, summary: string): void {
    super.recordIndependentReview(passed, summary);
    if (passed) { this.state.requirementsRevision = this.state.revision; this.state.reviewedRevision = this.state.revision; }
  }
  projection(): Record<string, unknown> {
    const excerpt = (value: string, size: number) => value.length <= size ? value : value.slice(0, size - 1) + "…";
    const check = (value: WorkflowState["localCheck"]) => ({ status: value.status, revision: value.revision, epoch: value.epoch, runId: excerpt(value.runId, 120), reason: excerpt(value.reason, 240) });
    return { taskMode: this.state.taskMode, intent: this.state.intent, objective: excerpt(this.state.objective, 800), phase: this.state.phase,
      revision: this.state.revision, effect: this.state.effect,
      todos: (this.state.todos ?? []).slice(0, 20).map(todo => ({ id: excerpt(todo.id, 40), text: excerpt(todo.text, 100), status: todo.status })),
      checks: { local: check(this.state.localCheck), broader: check(this.state.broaderCheck) },
      independentReview: { ...check(this.state.independentReview), reason: excerpt(this.state.independentReview.reason, 1200) },
      requirementReview: this.state.requirementReceipts.slice(0, 20).map(receipt => ({ requirementId: excerpt(receipt.requirementId, 40), summary: excerpt(receipt.summary, 240) })),
      omittedRequirementReviews: Math.max(0, this.state.requirementReceipts.length - 20),
      lastFailure: excerpt(this.state.lastFailure, 1200),
      changedFiles: this.state.changedFiles.slice(0, 12).map(path => excerpt(path, 100)),
      omittedChangedFiles: Math.max(0, this.state.changedFiles.length - 12),
      details: "Projection excerpts are bounded; full evidence remains available through read_evidence.",
      observationSequence: this.state.observationSequence, evidence: Object.fromEntries(this.state.observations.slice(-6).map(o => [excerpt(o.id, 100), { sequence: o.sequence, tool: excerpt(o.tool, 80), failed: o.failed, revision: o.revision }])) };
  }
}
