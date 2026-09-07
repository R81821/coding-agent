import { z } from "zod";
import type { ToolCall, WorkflowPhase, WorkflowState } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";

const text = z.string().trim().min(1).max(3000);
const updateSchema = z.object({
  action: z.enum(["understand", "plan", "diagnose", "requirements", "review"]),
  intent: z.enum(["analysis", "change"]).optional(),
  requirements: z.array(text).min(1).max(20).optional(),
  verification: z.array(z.object({ stage: z.enum(["local", "broader"]), command: text, cwd: z.string().default("."), timeoutMs: z.number().int().positive().max(3600000).default(120000) })).max(12).optional(),
  context: text.optional(), steps: z.array(text).min(1).max(12).optional(),
  cause: text.optional(), evidenceIds: z.array(z.string()).min(1).max(20).optional(),
  evidence: z.array(text).max(20).optional(), passed: z.boolean().optional(), summary: text.optional(),
});
const recon = new Set(["read_file", "list_files", "search_text", "read_range", "search_symbol", "repository_map", "find_references"]);
export function compactObservation(value: unknown, limit = 6000): string {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const raw = typeof value === "string" ? value : record && ("stdout" in record || "stderr" in record)
    ? JSON.stringify({ ...record, stdout: undefined, stderr: undefined }) + "\n" + String(record.stdout ?? "") + "\n" + String(record.stderr ?? "")
    : JSON.stringify(value) ?? "";
  if (raw.length <= limit) return raw;
  const errors = raw.split(/\r?\n/).filter(line => /error|fail|exception|trace|expected|actual|\bat\s/i.test(line)).slice(0, 20).join("\n").slice(0, Math.floor(limit / 3));
  const edge = Math.floor((limit - errors.length - 100) / 2);
  return `${raw.slice(0, edge)}\n[output truncated; full output is in the event log]\n${errors}\n${raw.slice(-edge)}`;
}

/** Runtime-owned gates. Model reports never set verification or revision counters. */
export class CodingWorkflow {
  readonly state: WorkflowState;
  constructor(objective: string, private readonly publish: (state: WorkflowState, detail: string) => void, recovered?: WorkflowState) {
    this.state = recovered ? structuredClone(recovered) : {
      phase: "task_understanding", objective: objective.slice(0, 6000), requirements: [], context: "", plan: [], hypotheses: [], verification: [], observations: [], relevantFiles: [], changedFiles: [], revision: 0,
      localRevision: -1, broaderRevision: -1, diffRevision: -1, requirementsRevision: -1, reviewedRevision: -1,
      failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "",
    };
    // Files can change while the process is offline. Never reuse successful checks after restart.
    if (recovered && (this.state.revision > 0 || this.state.intent === "change")) this.invalidate();
  }
  snapshot(): WorkflowState { return structuredClone(this.state); }
  move(phase: WorkflowPhase, detail: string): void { this.state.phase = phase; this.publish(this.snapshot(), detail); }
  invalidate(): void {
    Object.assign(this.state, { localRevision: -1, broaderRevision: -1, diffRevision: -1, requirementsRevision: -1, reviewedRevision: -1, requirementEvidence: [], review: "" });
  }
  get needsChange(): boolean { return this.state.intent === "change" || this.state.revision > 0; }
  tool(): ToolDefinition {
    return {
      contract: { name: "update_workflow", description: "Record task understanding and acceptance requirements (understand), then gather repository evidence. Record context, small steps, cause and actual observation evidenceIds (plan); propose verification items (stage local/broader, command, cwd, timeoutMs) matching the repository when Profile checks are insufficient. Runtime authorizes commands independently. After a failure use diagnose with revised cause and evidenceIds. After runtime verification and git_diff, report one evidence string per requirement with passed (requirements), then summary and passed (review). Cannot grant permissions or mark checks passed. Prefer minimal apply_patch edits; never unrelated rewrites.", inputSchema: z.toJSONSchema(updateSchema, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
      execute: async input => { this.update(input); return { output: this.snapshot() }; },
    };
  }
  before(call: ToolCall, tool: ToolDefinition): string | undefined {
    const mutation = (tool.assessRisk?.(call.input) ?? tool.contract.risk) !== "read" || call.name === "delegate";
    if (!mutation) return;
    this.state.intent = "change";
    if (!this.state.requirements.length) return "Before side effects, call update_workflow action=understand with intent=change and concrete requirements, then inspect relevant repository files.";
    if (!this.state.plan.length || !this.state.context || !this.state.hypotheses.length) return "Repository recon and update_workflow action=plan (context, steps, cause, observed evidenceIds) are required before side effects.";
    if (this.state.diagnosisRequired) return "A failure is unresolved. Call update_workflow action=diagnose with a revised hypothesis and evidence before editing again.";
  }
  starting(call: ToolCall, tool: ToolDefinition): void {
    if ((tool.assessRisk?.(call.input) ?? tool.contract.risk) === "read" && call.name !== "delegate") return;
    this.state.intent = "change";
    this.state.revision += 1;
    this.invalidate();
    const paths = [call.input.path, call.input.filePath, ...String(call.input.patch ?? "").split(/\r?\n/).filter(line => /^\+\+\+ b\//.test(line)).map(line => line.slice(6))].filter((v): v is string => typeof v === "string" && !!v);
    this.state.changedFiles = [...new Set([...this.state.changedFiles, ...paths])].slice(-80);
    this.move("small_edit", `执行 ${call.name}；版本 ${this.state.revision}，旧验证结果已失效`);
  }
  observe(call: ToolCall, result: ToolResult): void {
    if (call.name === "update_workflow") return;
    const failed = result.isError === true;
    this.state.observations.push({ id: call.id, tool: call.name, target: compactObservation(call.input, 500), summary: compactObservation(result.output, 1200), failed, revision: this.state.revision });
    this.state.observations = this.state.observations.slice(-32);
    if (recon.has(call.name) && !failed) {
      if (typeof call.input.path === "string") this.state.relevantFiles = [...new Set([...this.state.relevantFiles, call.input.path])].slice(-80);
      if (!this.state.plan.length) this.move("repository_recon", `取得 ${call.name} 证据 ${call.id}`);
    }
    if (call.name === "git_diff" && !failed && !result.truncated) this.state.diffRevision = this.state.revision;
    if (failed && this.needsChange) this.fail(`${call.name}: ${compactObservation(result.output, 1800)}`);
  }
  fail(reason: string): void {
    this.state.failures += 1;
    this.state.diagnosisRequired = true;
    this.state.lastFailure = reason.slice(0, 3000);
    this.invalidate();
    this.move("diagnose", this.strategy());
  }
  strategy(): string {
    return this.state.failures <= 1 ? "检查失败证据，修正局部假设" : this.state.failures === 2 ? "重读周边代码并扩大搜索范围" : "重新审视根因与架构假设，避免重复相同修复";
  }
  private evidence(ids: string[] | undefined): void {
    if (!ids?.length || ids.some(id => !this.state.observations.some(o => o.id === id))) throw new Error("evidenceIds must reference actual observed tool call IDs in working context.");
  }
  update(input: Record<string, unknown>): void {
    const value = updateSchema.parse(input);
    if (value.action === "understand") {
      if (this.state.requirements.length || this.state.revision > 0) throw new Error("Acceptance requirements are already recorded; do not remove or rewrite them during repair.");
      if (!value.intent || !value.requirements) throw new Error("understand requires intent and requirements.");
      this.state.intent = this.needsChange ? "change" : value.intent;
      this.state.requirements = value.requirements;
      this.move("task_understanding", "已记录任务目标和验收条件");
      this.move("repository_recon", "查找相关入口、调用链与测试");
      return;
    }
    if (value.action === "plan" || value.action === "diagnose") {
      if (!this.state.requirements.length || !value.context || !value.steps || !value.cause) throw new Error("Record understanding first; plan/diagnose requires context, steps, cause and evidenceIds.");
      this.evidence(value.evidenceIds);
      if (!this.state.observations.some(o => recon.has(o.tool) && !o.failed)) throw new Error("Successful repository reconnaissance is required before planning.");
      if (this.state.diagnosisRequired && value.action !== "diagnose") throw new Error("Use diagnose to update the failed hypothesis.");
      if (value.action === "diagnose" && value.cause === this.state.hypotheses.at(-1)?.cause) throw new Error("Revise the hypothesis using failure evidence instead of repeating it.");
      if (value.verification) {
        const additions = value.verification.filter(item => !this.state.verification.some(existing => existing.command === item.command && existing.cwd === item.cwd && existing.stage === item.stage));
        if (this.state.verification.length + additions.length > 12) throw new Error("At most 12 task verification commands are allowed.");
        if (additions.length) { this.state.verification.push(...additions); this.invalidate(); }
      }
      this.state.context = value.context;
      this.state.plan = value.steps;
      this.move("build_working_context", "整理相关代码、证据与待处理问题");
      this.state.hypotheses.push({ cause: value.cause, evidenceIds: value.evidenceIds!, revision: this.state.revision });
      this.state.hypotheses = this.state.hypotheses.slice(-8);
      this.state.diagnosisRequired = false;
      this.move(value.action === "diagnose" ? "update_hypothesis" : "plan_hypothesis", value.cause);
      return;
    }
    if (!this.checksCurrent() || this.state.diffRevision !== this.state.revision) throw new Error("Current revision must pass runtime verification and have a complete git_diff before requirement checks or final review.");
    if (value.action === "requirements") {
      if (value.passed === false) { this.fail(value.summary ?? "Acceptance requirements not met; revise the hypothesis."); return; }
      if (value.passed !== true || value.evidence?.length !== this.state.requirements.length || !value.evidence.length) throw new Error("Provide passed and one evidence entry per recorded requirement.");
      this.state.requirementEvidence = value.evidence;
      this.state.requirementsRevision = this.state.revision;
      this.move("requirements_check", "已逐项记录需求证据");
    } else {
      if (this.state.requirementsRevision !== this.state.revision) throw new Error("Check each requirement before final review.");
      if (value.passed === false) { this.fail(value.summary ?? "Final review found unresolved issues."); return; }
      if (value.passed !== true || !value.summary) throw new Error("Final review requires passed and a summary of scope, regressions and edge cases.");
      this.state.review = value.summary;
      this.state.reviewedRevision = this.state.revision;
      this.move("final_review", value.summary);
    }
  }
  checksCurrent(): boolean { return !this.state.diagnosisRequired && this.state.localRevision === this.state.revision && this.state.broaderRevision === this.state.revision; }
  canFinish(): boolean { return this.checksCurrent() && this.state.diffRevision === this.state.revision && this.state.requirementsRevision === this.state.revision && this.state.reviewedRevision === this.state.revision; }
}