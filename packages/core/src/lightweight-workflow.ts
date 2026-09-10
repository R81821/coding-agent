import type { ToolCall, WorkflowState, VerificationRun } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";
import { CodingWorkflow } from "./coding-workflow.js";
import type { ExecutionEffect } from "./workspace-impact.js";

const readOnlyGitQuery = /^(?:git status --short|git diff --no-ext-diff|git log -5 --oneline|git rev-parse --show-toplevel)$/;
/** The only terminal commands analysis mode trusts. */
function isReadOnlyGitQuery(call: ToolCall): boolean {
  return call.name === "terminal" && call.input.stdin === undefined && readOnlyGitQuery.test(String(call.input.command).trim());
}
/** A successful repository recheck: a complete diff, or one of the allowlisted read-only Git queries. */
function isRepositoryRecheck(call: ToolCall): boolean {
  return call.name === "git_diff" || isReadOnlyGitQuery(call);
}

/** Runtime-owned gates; todo status is never acceptance evidence. */
export class LightweightWorkflow extends CodingWorkflow {
  constructor(objective: string, publish: (state: WorkflowState, detail: string) => void, recovered?: WorkflowState, policy: ConstructorParameters<typeof CodingWorkflow>[3] = {}, taskMode: "auto" | "analysis" | "change" = "auto") {
    super(objective, publish, recovered, policy);
    this.state.schemaVersion = 3;
    this.state.taskMode = taskMode;
    this.state.todos ??= [];
    this.state.intent = taskMode === "change" || this.state.revision > 0 ? "change" : "analysis";
    this.state.requirements = [objective.slice(0, 3000)];
    this.state.requirementIds = ["req-1"];
  }
  override before(call: ToolCall, tool: ToolDefinition): string | undefined {
    if (this.state.taskMode !== "analysis") return;
    const risk = tool.assessRisk?.(call.input) ?? tool.contract.risk;
    if (risk === "read") return;
    // A probe is the one sanctioned way to run a local program during analysis: it executes inside
    // an isolated probe directory outside the repository, its own artifacts never count as a
    // repository change, and any change it makes to tracked content is still detected afterwards.
    // Destructive commands, raw terminal commands and repository writes keep the original policy.
    if (call.name === "probe" && risk !== "destructive") return;
    if (isReadOnlyGitQuery(call)) return;
    return "analysis_mode_read_only: use read_file/search_files/git_diff or the probe tool; repository writes require auto/change mode.";
  }
  override starting(_call?: ToolCall, _tool?: ToolDefinition): void { /* Content effects determine revisions after execution. */ }
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
      // write (below) or a successful repository recheck in observe() resolves it.
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
    if (["todo", "read_evidence", "run_verification"].includes(call.name)) return;
    if (this.state.effect === "unknown" && result.isError !== true && isRepositoryRecheck(call)) this.state.effect = "read";
    super.observe(call, result);
    if (!this.needsChange) this.state.diagnosisRequired = false;
  }
  override fail(reason: string, source?: string): void {
    super.fail(reason, source);
    this.state.diagnosisRequired = false;
  }
  override recordVerification(run: VerificationRun): void {
    if (!this.needsChange && !run.passed) { this.move("inspect_result", "探针失败；可修复或说明未验证范围"); return; }
    super.recordVerification(run);
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
  override get requiresIndependentReview(): boolean { return this.needsChange && this.state.riskFlags.length > 0; }
  acceptFinalReport(text: string): void {
    if (!text.trim() || !this.checksCurrent() || (this.needsChange && this.state.diffRevision !== this.state.revision)) return;
    const evidence = this.state.observations.filter(o => !o.failed && o.complete && o.epoch === this.state.epoch);
    if (!evidence.length) return;
    const diff = evidence.findLast(o => o.tool === "git_diff" && o.revision === this.state.revision);
    this.state.requirementsRevision = this.state.revision;
    this.state.reviewedRevision = this.state.revision;
    this.state.review = text.slice(0, 3000);
    this.state.reviewEvidenceIds = diff ? [diff.id] : [evidence.at(-1)!.id];
    this.state.requirementReceipts = [{ requirementId: "req-1", summary: text.slice(0, 3000), observationIds: this.state.reviewEvidenceIds, verificationIds: [this.state.localCheck.runId].filter(Boolean), diffObservationId: diff?.id ?? "" }];
  }
  override baseCanFinish(): boolean {
    return this.checksCurrent() && (!this.needsChange || this.state.diffRevision === this.state.revision) && this.state.reviewedRevision === this.state.revision;
  }
  projection(): Record<string, unknown> {
    return { taskMode: this.state.taskMode, intent: this.state.intent, objective: this.state.objective.slice(0, 1000), phase: this.state.phase,
      revision: this.state.revision, effect: this.state.effect, todos: this.state.todos,
      checks: { local: this.state.localCheck, broader: this.state.broaderCheck }, changedFiles: this.state.changedFiles.slice(0, 40),
      observationSequence: this.state.observationSequence, evidence: Object.fromEntries(this.state.observations.slice(-8).map(o => [o.id, { sequence: o.sequence, tool: o.tool, failed: o.failed, revision: o.revision }])) };
  }
}
