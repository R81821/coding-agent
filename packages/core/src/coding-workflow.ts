import { z } from "zod";
import { createHash } from "node:crypto";
import { newId, WorkflowStateSchema, RequirementReceiptSchema } from "@harness/protocol";
import type { ToolCall, VerificationRun, WorkflowPhase, WorkflowState } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";

const text = z.string().trim().min(1).max(3000);
const updateSchema = z.object({
  action: z.enum(["understand", "plan", "diagnose", "requirements", "review", "request_verification"]),
  intent: z.enum(["analysis", "change"]).optional(),
  requirements: z.array(text).min(1).max(20).optional(),
  verification: z.array(z.object({ stage: z.enum(["local", "broader"]), command: text, cwd: z.string().default("."), timeoutMs: z.number().int().positive().max(3600000).default(120000) })).max(12).optional(),
  context: text.optional(), steps: z.array(text).min(1).max(12).optional(),
  cause: text.optional(), evidenceIds: z.array(z.string()).min(1).max(20).optional(),
  evidence: z.array(RequirementReceiptSchema).max(20).optional(),
  alternatives: z.array(text).min(2).max(4).optional(),
  experiment: z.object({ question: text, expectedResults: z.array(text).min(2).max(4), observationIds: z.array(z.string()).min(1).max(8) }).optional(), passed: z.boolean().optional(), summary: text.optional(),
});
const requiredFields: Record<string, string[]> = {
  understand: ["intent", "requirements"], plan: ["context", "steps", "cause", "evidenceIds"],
  diagnose: ["context", "steps", "cause", "evidenceIds"], requirements: ["passed"], review: ["passed"], request_verification: [],
};
const workflowInputSchema = {
  ...z.toJSONSchema(updateSchema, { io: "input" }),
  anyOf: Object.entries(requiredFields).map(([action, fields]) => ({ properties: { action: { const: action } }, required: ["action", ...fields] })),
};
class MissingVerificationConfigError extends Error {}
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
  constructor(objective: string, private readonly publish: (state: WorkflowState, detail: string) => void, recovered?: WorkflowState, private readonly policy: { items?: { stage?: "local" | "broader" | undefined; required: boolean }[]; broaderPolicy?: "required" | "optional" | "disabled" | undefined; reviewPolicy?: "standard" | "risk_based" | undefined } = {}) {
    this.state = WorkflowStateSchema.parse(recovered ? structuredClone(recovered) : {
      phase: "task_understanding", objective: objective.slice(0, 6000), requirements: [], context: "", plan: [], hypotheses: [], verification: [], observations: [], relevantFiles: [], changedFiles: [], revision: 0,
      localRevision: -1, broaderRevision: -1, diffRevision: -1, requirementsRevision: -1, reviewedRevision: -1,
      failures: 0, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "",
    });
    this.state.epoch = newId("epoch");
    this.state.schemaVersion = 2;
    this.state.broaderPolicy = policy.broaderPolicy ?? "optional";
    this.state.reviewPolicy = policy.reviewPolicy ?? "standard";
    this.state.requirementIds = this.state.requirements.map((_, i) => `req-${i + 1}`);
    // Files can change while the process is offline. Never reuse successful checks after restart.
    if (recovered) this.invalidate();
  }
  snapshot(): WorkflowState { return structuredClone(this.state); }
  move(phase: WorkflowPhase, detail: string): void { this.state.phase = phase; this.publish(this.snapshot(), detail); }
  invalidate(): void {
    const pending = () => ({ status: "pending" as const, revision: -1, epoch: this.state.epoch, runId: "", reason: "" });
    Object.assign(this.state, { localCheck: pending(), broaderCheck: pending(), independentReview: pending(), requirementReceipts: [], reviewEvidenceIds: [], localRevision: -1, broaderRevision: -1, diffRevision: -1, requirementsRevision: -1, reviewedRevision: -1, requirementEvidence: [], review: "" });
  }
  get needsChange(): boolean { return this.state.intent === "change" || this.state.revision > 0; }
  tool(): ToolDefinition {
    return {
      contract: { name: "update_workflow", description: "Record task understanding and acceptance requirements (understand), then gather repository evidence. Record context, small steps, cause and actual observation evidenceIds (plan); propose verification items (stage local/broader, command, cwd, timeoutMs) matching the repository when Profile checks are insufficient. Runtime authorizes commands independently. After a failure use diagnose with revised cause and fresh evidenceIds from the current failure or later observations. Repeated failures require fresh successful repository checks; at level 3 provide alternatives and experiment (question, expectedResults, observationIds). Complete a small coherent batch of edits (including required test scripts), then call request_verification to let runtime run checks. Terminal commands alone do not trigger verification. request_verification accepts verification items to fill missing configuration in the same run; keep required scripts until these commands execute. Missing configuration is recoverable, not a code failure. After runtime verification and git_diff, report one structured evidence object per requirementId (summary, observationIds, verificationIds, diffObservationId), then summary, evidenceIds including current diff, and passed (review). Only current epoch/revision successful evidence is accepted. Cannot grant permissions or mark checks passed. Prefer minimal apply_patch edits; never unrelated rewrites.", inputSchema: workflowInputSchema, risk: "read", idempotent: false, timeoutMs: 1000 },
      handlesInputValidation: true,
      execute: async input => {
        try {
          this.update(input);
          return { output: { ...this.snapshot(), missingVerificationStages: this.missingVerificationStages() } };
        } catch (error) {
          const fields = requiredFields[String(input.action)] ?? ["action"];
          return { isError: true, output: {
            code: error instanceof MissingVerificationConfigError ? "verification_config_missing" : error instanceof z.ZodError || fields.some(field => input[field] === undefined) ? "workflow_input_invalid" : "workflow_gate_rejected",
            error: error instanceof Error ? error.message : String(error), recoverable: true, action: input.action,
            requiredFields: fields, missingFields: fields.filter(field => input[field] === undefined),
            ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } : {}),
            activeFailureId: this.state.activeFailureId,
            availableEvidenceIds: (input.action === "diagnose" ? this.diagnosisEvidence() : this.state.observations.filter(item => item.epoch === this.state.epoch)).map(item => item.id),
            missingVerificationStages: this.missingVerificationStages(),
            nextAction: error instanceof MissingVerificationConfigError
              ? "Supply verification items (stage, command, cwd, timeoutMs) in request_verification; keep scripts available. Runtime still authorizes and executes each command."
              : "Correct the reported fields. For diagnose cite availableEvidenceIds and a revised cause; repeated failures still require fresh repository inspection.",
          } };
        }
      },
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
    if ((tool.assessRisk?.(call.input) ?? tool.contract.risk) === "destructive") this.addRisk("destructive_operation");
    if (String(call.input.patch ?? "").split("\n").filter(line => /^[+-](?![+-])/.test(line)).length > 200) this.addRisk("large_patch");
    this.invalidate();
    const patchPaths = String(call.input.patch ?? "").split(/\r?\n/).flatMap(line => {
      if (/^(?:\+\+\+ b|--- a)\//.test(line)) return [line.slice(6).split("\t")[0]!];
      const renamed = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
      if (renamed) return [renamed[1]!];
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      return header ? [header[1]!, header[2]!] : [];
    });
    const paths = [call.input.path, call.input.filePath, ...patchPaths].filter((v): v is string => typeof v === "string" && !!v);
    this.state.changedFiles = [...new Set([...this.state.changedFiles, ...paths])].slice(-80);
    if (!paths.length) this.addRisk("unknown_mutation_scope");
    if (this.state.changedFiles.length > 3) this.addRisk("multiple_files");
    if (paths.some(path => /auth|security|migration|schema/i.test(path))) this.addRisk("sensitive_path");
    this.move("small_edit", `执行 ${call.name}；版本 ${this.state.revision}，旧验证结果已失效`);
  }
  private addRisk(flag: string): void { this.state.riskFlags = [...new Set([...this.state.riskFlags, flag])]; }
  private record(id: string, tool: string, target: string, summary: string, failed: boolean, kind: "tool" | "verification" | "failure" = "tool", complete = true) {
    const entry = { complete, id, tool, target, summary: compactObservation(summary, 1200), failed, revision: this.state.revision, epoch: this.state.epoch, sequence: ++this.state.observationSequence, failureId: this.state.activeFailureId, kind, digest: createHash("sha256").update(summary).digest("hex") };
    this.state.observations.push(entry);
    // Legacy runs keep the small sliding window. Schema v3 keeps a much longer, still bounded
    // history so the projection and checkpoints cannot grow without limit on long runs; anything
    // older stays retrievable through read_evidence from the event log.
    this.state.observations = this.state.observations.slice(this.state.schemaVersion < 3 ? -32 : -512);
    return entry;
  }
  private resolveSource(source: string): void {
    for (const chain of this.state.failureChains) if (chain.source === source) chain.status = "resolved";
  }
  observe(call: ToolCall, result: ToolResult): void {
    if (call.name === "update_workflow") return;
    const failed = result.isError === true;
    const target = compactObservation(call.input, 500);
    const observation = this.record(call.id, call.name, target, compactObservation(result.output, 1200), failed, "tool", result.truncated !== true);
    this.state.activity = call.name + " " + target;
    if (recon.has(call.name) && !failed) {
      if (typeof call.input.path === "string") this.state.relevantFiles = [...new Set([...this.state.relevantFiles, call.input.path])].slice(-80);
      // Early reads remain permitted, but do not pretend understanding has completed.
      if (this.state.requirements.length && !this.state.plan.length) this.move("repository_recon", "取得证据 " + call.id);
    }
    if (call.name === "git_diff") this.state.diffRevision = !failed && !result.truncated ? this.state.revision : -1;
    const source = "tool:" + call.name + ":" + JSON.stringify({ path: call.input.path, cwd: call.input.cwd, command: call.input.command, stdinDigest: typeof call.input.stdin === "string" ? createHash("sha256").update(call.input.stdin).digest("hex") : undefined });
    if (failed && this.needsChange) this.fail(call.name + ": " + compactObservation(result.output, 1800), source, observation);
    else if (!failed) this.resolveSource(source);
    this.publish(this.snapshot(), "工具活动：" + call.name);
  }
  fail(reason: string, source = "workflow", origin?: WorkflowState["observations"][number]): void {
    this.state.failures += 1;
    this.state.diagnosisRequired = true;
    this.state.lastFailure = reason.slice(0, 3000);
    this.invalidate();
    const signature = (reason.split(/\r?\n/).find(line => /error|fail|exception|timeout|ENOENT|EACCES/i.test(line)) ?? reason).toLowerCase().replace(/\b\d+\b/g, "#").slice(0, 300);
    const fingerprint = createHash("sha256").update(source + ":" + signature).digest("hex");
    let chain = this.state.failureChains.find(item => item.fingerprint === fingerprint && item.status === "open");
    if (!chain) {
      chain = { id: newId("failure-chain"), source, fingerprint, count: 0, status: "open", lastSequence: 0, lastRevision: this.state.revision, epoch: this.state.epoch, failureId: "" };
      this.state.failureChains.push(chain);
      this.state.failureChains = this.state.failureChains.slice(-16);
    }
    chain.count += 1;
    chain.epoch = this.state.epoch;
    chain.lastRevision = this.state.revision;
    chain.failureId = this.state.activeFailureId = newId("failure");
    this.state.activeChainId = chain.id;
    if (origin) origin.failureId = chain.failureId;
    const observed = this.record(chain.failureId, source, source, reason, true, "failure");
    chain.lastSequence = observed.sequence;
    this.move("diagnose", this.strategy());
  }
  get failureLevel(): number { return this.state.failureChains.find(chain => chain.id === this.state.activeChainId && chain.status === "open")?.count ?? 0; }
  strategy(): string {
    return this.failureLevel <= 1 ? "引用本次失败证据，修正局部假设" : this.failureLevel === 2 ? "必须补充失败后的成功读取或搜索证据" : "必须补充扩大搜索、替代假设和可区分假设的实验结果";
  }
  recordVerification(run: VerificationRun): void {
    if ((run.epoch && run.epoch !== this.state.epoch) || (run.revision !== undefined && run.revision !== this.state.revision)) throw new Error("Stale verification result.");
    const stage = run.stage ?? "local";
    const outcome = run.outcome ?? (run.passed ? "passed" : "failed");
    const current = { status: outcome, revision: this.state.revision, epoch: this.state.epoch, runId: run.id, reason: run.skipReason ?? "" };
    if (stage === "local") { this.state.localCheck = current; this.state.localRevision = outcome === "passed" ? this.state.revision : -1; }
    else { this.state.broaderCheck = current; this.state.broaderRevision = outcome === "passed" ? this.state.revision : -1; }
    const observation = this.record(run.id, "verification:" + stage, stage, JSON.stringify({ outcome, results: run.results.map(item => ({ ...item, output: compactObservation(item.output, 1000) })) }), outcome !== "passed", "verification");
    for (const item of run.results) if (item.passed) this.resolveSource("verification:" + stage + ":" + item.itemId);
    if (outcome === "failed") {
      const failed = run.results.find(item => !item.passed);
      this.fail(failed?.output || run.skipReason || "Required verification is missing", "verification:" + stage + ":" + (failed?.itemId ?? "configuration"), observation);
      // Keep the observed failed stage visible after other gates are invalidated.
      if (stage === "local") this.state.localCheck = current; else this.state.broaderCheck = current;
    }
  }
  private freshEvidence(ids: string[], successful = true) {
    const entries = ids.map(id => this.state.observations.find(item => item.id === id));
    if (entries.some(item => !item || item.epoch !== this.state.epoch || item.revision !== this.state.revision || (successful && (item.failed || !item.complete)))) throw new Error("Evidence must be successful and belong to the current epoch and revision.");
    return entries as WorkflowState["observations"];
  }
  get requiresIndependentReview(): boolean { return this.state.reviewPolicy === "risk_based" && this.state.riskFlags.length > 0; }
  recordIndependentReview(passed: boolean, summary: string): void {
    if (!this.baseCanFinish()) throw new Error("Complete requirement and diff evidence before independent review.");
    const review = { status: passed ? "passed" as const : "failed" as const, epoch: this.state.epoch, revision: this.state.revision, runId: newId("independent-review"), reason: summary };
    if (!passed) this.fail(summary, "independent-review");
    else this.resolveSource("independent-review");
    this.state.independentReview = review;
    this.move(passed ? "final_review" : "diagnose", "独立只读评审：" + summary);
  }
  private diagnosisEvidence() {
    const chain = this.state.failureChains.find(item => item.id === this.state.activeChainId);
    return this.state.observations.filter(item => chain && item.epoch === this.state.epoch &&
      (item.sequence >= chain.lastSequence || (item.failed && item.failureId === chain.failureId)));
  }
  missingVerificationStages(): ("local" | "broader")[] {
    const items = [...(this.policy.items ?? []), ...this.state.verification.map(item => ({ ...item, required: true }))];
    const missing: ("local" | "broader")[] = [];
    if (this.needsChange && !items.some(item => (item.stage ?? "local") === "local" && item.required)) missing.push("local");
    if (this.state.broaderPolicy === "required" && !items.some(item => item.stage === "broader")) missing.push("broader");
    return missing;
  }
  private addVerification(items: z.infer<typeof updateSchema>["verification"]): void {
    if (!items) return;
    const additions = items.filter((item, index) => ![...this.state.verification, ...items.slice(0, index)].some(existing => existing.command === item.command && existing.cwd === item.cwd && existing.stage === item.stage));
    if (this.state.verification.length + additions.length > 12) throw new Error("At most 12 task verification commands are allowed.");
    if (additions.length) { this.state.verification.push(...additions); this.invalidate(); }
  }
  private evidence(ids: string[] | undefined): void {
    if (!ids?.length || ids.some(id => !this.state.observations.some(o => o.id === id))) throw new Error("evidenceIds must reference actual observed tool call IDs in working context.");
  }
  update(input: Record<string, unknown>): void {
    const missing = (requiredFields[String(input.action)] ?? []).filter(field => input[field] === undefined);
    if (missing.length) throw new Error(String(input.action) + " requires missing fields: " + missing.join(", "));
    const value = updateSchema.parse(input);
    if (value.action === "understand") {
      if (this.state.requirements.length || this.state.revision > 0) throw new Error("Acceptance requirements are already recorded; do not remove or rewrite them during repair.");
      if (!value.intent || !value.requirements) throw new Error("understand requires intent and requirements.");
      this.state.intent = this.needsChange ? "change" : value.intent;
      this.state.requirements = value.requirements;
      this.state.requirementIds = value.requirements.map((_, i) => `req-${i + 1}`);
      this.move("task_understanding", "已记录任务目标和验收条件");
      this.move("repository_recon", "查找相关入口、调用链与测试");
      return;
    }
    if (value.action === "plan" || value.action === "diagnose") {
      if (!this.state.requirements.length) throw new Error("Record understanding first with intent and requirements.");
      if (!value.context || !value.steps || !value.cause) throw new Error("plan/diagnose requires nonempty context, steps and cause.");
      this.evidence(value.evidenceIds);
      if (!this.state.observations.some(o => recon.has(o.tool) && !o.failed)) throw new Error("Successful repository reconnaissance is required before planning.");
      if (this.state.diagnosisRequired && value.action !== "diagnose") throw new Error("Use diagnose to update the failed hypothesis.");
      if (value.action === "diagnose" && value.cause.trim().toLowerCase() === this.state.hypotheses.at(-1)?.cause.trim().toLowerCase()) throw new Error("Revise the hypothesis using failure evidence instead of repeating it.");
      if (value.action === "diagnose") {
        const chain = this.state.failureChains.find(item => item.id === this.state.activeChainId);
        if (!this.state.diagnosisRequired || !chain) throw new Error("No current failure requires diagnosis.");
        const cited = value.evidenceIds!.map(id => this.state.observations.find(item => item.id === id)!);
        const fresh = cited.filter(item => this.diagnosisEvidence().includes(item));
        if (!fresh.length) throw new Error("Diagnosis requires this failure's evidence or observations collected after it.");
        const exploration = fresh.filter(item => !item.failed && item.sequence > chain.lastSequence && recon.has(item.tool));
        if (chain.count >= 2 && !exploration.length) throw new Error("Repeated failure requires fresh successful repository inspection.");
        if (chain.count >= 3) {
          if (!value.alternatives || new Set(value.alternatives.map(item => item.toLowerCase())).size < 2 || !value.experiment) throw new Error("Deep diagnosis requires distinct alternatives and a distinguishing experiment.");
          this.evidence(value.experiment.observationIds);
          const experiments = value.experiment.observationIds.map(id => this.state.observations.find(item => item.id === id)!);
          if (!exploration.some(item => /search|references|map/.test(item.tool)) || !experiments.some(item => !item.failed && item.epoch === this.state.epoch && item.sequence > chain.lastSequence)) throw new Error("Deep diagnosis needs fresh expanded search and observed experiment results.");
        }
      }
      this.addVerification(value.verification);
      this.state.context = value.context;
      this.state.plan = value.steps;
      this.move("build_working_context", "整理相关代码、证据与待处理问题");
      this.state.hypotheses.push({ ...(value.alternatives ? { alternatives: value.alternatives } : {}), ...(value.experiment ? { experiment: value.experiment } : {}), cause: value.cause, evidenceIds: value.evidenceIds!, revision: this.state.revision });
      this.state.hypotheses = this.state.hypotheses.slice(-8);
      this.state.diagnosisRequired = false;
      this.move(value.action === "diagnose" ? "update_hypothesis" : "plan_hypothesis", value.cause);
      return;
    }
    if (value.action === "request_verification") {
      if (value.passed !== undefined) throw new Error("Only runtime can report verification results.");
      if (this.state.diagnosisRequired) throw new Error("Diagnose the current failure before requesting verification.");
      if (this.needsChange && !this.state.plan.length) throw new Error("Record a plan before requesting verification.");
      this.addVerification(value.verification);
      const missing = this.missingVerificationStages();
      if (missing.length) throw new MissingVerificationConfigError("Missing required verification configuration for " + missing.join(", ") + ". Supply verification items in request_verification before running checks.");
      return;
    }
    if (!this.checksCurrent() || this.state.diffRevision !== this.state.revision) throw new Error("Call request_verification for runtime verification, then read a complete git_diff for the current revision before requirement checks or final review.");
    if (value.action === "requirements") {
      if (value.passed === false) { this.fail(value.summary ?? "Acceptance requirements not met; revise the hypothesis.", "requirements"); return; }
      if (value.passed !== true || value.evidence?.length !== this.state.requirements.length || !value.evidence.length) throw new Error("Provide passed and one evidence entry per recorded requirement.");
      if (new Set(value.evidence.map(item => item.requirementId)).size !== this.state.requirementIds.length || value.evidence.some(item => !this.state.requirementIds.includes(item.requirementId))) throw new Error("Provide every stable requirementId exactly once.");
      for (const item of value.evidence) {
        this.freshEvidence(item.observationIds);
        const diff = this.freshEvidence([item.diffObservationId])[0];
        if (diff?.tool !== "git_diff") throw new Error("Requirement evidence must reference the current git_diff.");
        for (const id of item.verificationIds) if (![this.state.localCheck, this.state.broaderCheck].some(check => check.runId === id && check.status === "passed" && check.epoch === this.state.epoch && check.revision === this.state.revision)) throw new Error("Unknown, failed, skipped or stale verification reference.");
      }
      this.state.requirementReceipts = value.evidence;
      this.state.requirementEvidence = value.evidence.map(item => item.summary);
      this.resolveSource("requirements");
      this.state.requirementsRevision = this.state.revision;
      this.move("requirements_check", "已逐项记录需求证据");
    } else {
      if (this.state.requirementsRevision !== this.state.revision) throw new Error("Check each requirement before final review.");
      if (value.passed === false) { this.fail(value.summary ?? "Final review found unresolved issues.", "review"); return; }
      if (value.passed !== true || !value.summary) throw new Error("Final review requires passed and a summary of scope, regressions and edge cases.");
      if (!value.evidenceIds?.length || !this.freshEvidence(value.evidenceIds).some(item => item.tool === "git_diff")) throw new Error("Final review must cite current successful diff evidence.");
      this.state.reviewEvidenceIds = value.evidenceIds;
      this.resolveSource("review");
      this.state.review = value.summary;
      this.state.reviewedRevision = this.state.revision;
      this.move("final_review", value.summary);
    }
  }
  checksCurrent(): boolean {
    const current = (check: WorkflowState["localCheck"]) => check.epoch === this.state.epoch && check.revision === this.state.revision;
    return !this.state.diagnosisRequired && current(this.state.localCheck) && (this.state.localCheck.status === "passed" || (!this.needsChange && this.state.localCheck.status === "skipped" && !!this.state.localCheck.reason))
      && current(this.state.broaderCheck) && (this.state.broaderCheck.status === "passed" || (this.state.broaderPolicy !== "required" && this.state.broaderCheck.status === "skipped" && !!this.state.broaderCheck.reason));
  }
  baseCanFinish(): boolean { return this.checksCurrent() && this.state.diffRevision === this.state.revision && this.state.requirementsRevision === this.state.revision && this.state.reviewedRevision === this.state.revision && this.state.requirementReceipts.length === this.state.requirements.length; }
  canFinish(): boolean { return this.baseCanFinish() && (!this.requiresIndependentReview || (this.state.independentReview.status === "passed" && this.state.independentReview.epoch === this.state.epoch && this.state.independentReview.revision === this.state.revision)); }
}
