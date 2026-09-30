import { z } from "zod";
import { SequentialPlanStepSchema, SequentialWorkflowSchema, StepVerificationSchema, type Profile, type ToolCall, type VerificationRun } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";
import { LightweightWorkflow } from "./lightweight-workflow.js";
import { validateVerificationInput } from "./runtime-tools.js";
import type { ExecutionEffect } from "./workspace-impact.js";

const text = z.string().trim().min(1).max(3000);
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("understand"), summary: text, requirements: z.array(text).min(1).max(20) }),
  z.object({ action: z.literal("architecture"), summary: text, evidenceIds: z.array(z.string()).min(1).max(20) }),
  z.object({ action: z.literal("plan"), steps: z.array(SequentialPlanStepSchema).min(1).max(20), integration: z.array(StepVerificationSchema).min(1).max(8), reason: text.optional() }),
  z.object({ action: z.literal("start_step"), stepId: z.string() }),
  z.object({ action: z.literal("reopen_step"), stepId: z.string(), reason: text }),
]);
const reconTools = new Set(["read_file", "read_range", "search_files", "search_text", "list_files", "repository_map", "search_symbol", "find_references"]);
const pending = () => ({ status: "pending" as const, revision: -1, epoch: "", runId: "", reason: "" });

/** Step transitions depend on runtime verification receipts, never on todo or model claims. */
export class SequentialWorkflow extends LightweightWorkflow {
  constructor(...args: ConstructorParameters<typeof LightweightWorkflow>) {
    super(...args);
    this.state.schemaVersion = 4;
    this.state.sequential = SequentialWorkflowSchema.parse(args[2]?.sequential ?? {});
    if (args[2]?.sequential?.understanding) {
      this.state.requirements = [...args[2].requirements];
      this.state.requirementIds = [...args[2].requirementIds];
    }
    if (args[2]) {
      this.sequence.architectureEpoch = "";
      this.sequence.understoodAt = this.state.observationSequence;
      this.resetFrom(0);
    }
    if (this.needsChange || this.sequence.steps.length) this.state.broaderPolicy = "required";
  }

  private get sequence() { return this.state.sequential!; }
  private get activeStep() { return this.sequence.steps.find(step => step.id === this.sequence.activeStepId); }
  private get prepared() { return !!this.sequence.understanding && !!this.sequence.architecture && this.sequence.architectureEpoch === this.state.epoch; }
  private resetFrom(index: number): void {
    for (const step of this.sequence.steps.slice(index)) { step.status = "pending"; step.check = pending(); }
    this.sequence.activeStepId = "";
    this.invalidate();
  }

  planningTool(): ToolDefinition {
    return {
      contract: { name: "advance_workflow", description: "For repository changes: understand (summary and acceptance requirements), inspect repository, architecture (summary citing fresh successful repository evidenceIds), plan (ordered steps with verification commands and mandatory integration commands), then start_step in order. run_verification executes the planned checks; only real passing results verify a step. After every step is verified run stage=broader for integration, read git_diff, and report for independent review. Reopen a step with a reason to repair it and invalidate its successors. Replacing a plan requires a reason and revalidation of all steps. No action grants permissions or marks tests passed.", inputSchema: z.toJSONSchema(inputSchema, { io: "input" }), risk: "read", idempotent: false, timeoutMs: 1000 },
      handlesInputValidation: true,
      execute: async input => {
        try { this.advance(input); return { output: this.projection() }; }
        catch (error) { return { isError: true, output: { code: "workflow_gate_rejected", error: String(error), nextAction: this.nextAction() } }; }
      },
    };
  }

  advance(input: Record<string, unknown>): void {
    const value = inputSchema.parse(input);
    if (this.state.taskMode === "analysis") throw new Error("Analysis tasks do not enter the implementation workflow.");
    const sequence = this.sequence;
    if (value.action === "understand") {
      if (sequence.steps.length) throw new Error("Keep the accepted requirements while repairing or revising a plan.");
      sequence.understanding = value.summary;
      sequence.understoodAt = this.state.observationSequence;
      sequence.architecture = "";
      sequence.architectureEpoch = "";
      this.state.requirements = value.requirements;
      this.state.requirementIds = value.requirements.map((_, index) => `req-${index + 1}`);
      this.state.intent = "change";
      this.state.broaderPolicy = "required";
      this.move("repository_recon", "已记录需求；探索相关文件、入口和测试");
      return;
    }
    if (value.action === "architecture") {
      if (!sequence.understanding) throw new Error("Record understand before architecture.");
      const evidence = value.evidenceIds.map(id => this.state.observations.find(item => item.id === id));
      if (evidence.some(item => !item || !reconTools.has(item.tool) || item.failed || !item.complete || item.epoch !== this.state.epoch || item.revision !== this.state.revision || item.sequence <= sequence.understoodAt)) throw new Error("Architecture requires fresh successful repository reads/searches after understanding, in the current epoch and revision.");
      sequence.architecture = value.summary;
      sequence.architectureEpoch = this.state.epoch;
      sequence.evidenceIds = value.evidenceIds;
      this.state.context = value.summary;
      this.move("identify_architecture", "已记录模块职责、依赖和变更边界；制定分步计划");
      return;
    }
    if (!this.prepared) throw new Error("Understand the requirement and identify architecture using current repository evidence first.");
    if (value.action === "plan") {
      if (sequence.steps.length && !value.reason) throw new Error("Revising a plan requires a reason; all step checks will be invalidated.");
      if (new Set(value.steps.map(step => step.id)).size !== value.steps.length) throw new Error("Step IDs must be unique.");
      for (const check of [...value.steps.flatMap(step => step.verification), ...value.integration]) validateVerificationInput(check);
      sequence.generation++;
      sequence.steps = value.steps.map(step => ({ ...step, status: "pending", check: pending() }));
      sequence.integration = value.integration;
      this.resetFrom(0);
      this.state.plan = value.steps.map(step => step.text);
      this.state.intent = "change";
      this.state.broaderPolicy = "required";
      this.move("plan_hypothesis", "计划已记录；每一步验证通过后才能开始下一步");
      return;
    }
    const index = sequence.steps.findIndex(step => step.id === value.stepId);
    if (index < 0) throw new Error("Unknown stepId; use a step from the implementation plan.");
    if (sequence.steps.slice(0, index).some(step => step.status !== "verified" || step.check.epoch !== this.state.epoch)) throw new Error("Verify every previous step before starting this step.");
    if (value.action === "reopen_step") this.resetFrom(index);
    else if (this.activeStep?.status === "in_progress" && this.activeStep.id !== value.stepId) throw new Error("The current step must pass verification first.");
    else if (sequence.steps[index]!.status === "verified") throw new Error("Use reopen_step with a reason to change a verified step.");
    const step = sequence.steps[index]!;
    sequence.activeStepId = step.id;
    step.status = "in_progress";
    step.check = pending();
    this.invalidate();
    this.move("small_edit", `实施步骤 ${index + 1}/${sequence.steps.length}：${step.text}`);
  }

  override before(call: ToolCall, tool: ToolDefinition): string | undefined {
    const base = super.before(call, tool);
    if (base || this.state.taskMode === "analysis") return base;
    if (call.name === "run_verification") return this.verificationGate(call.input.stage === "broader" ? "broader" : "local");
    const risk = tool.assessRisk?.(call.input) ?? tool.contract.risk;
    if (risk === "read" && call.name !== "delegate") return;
    if (call.name === "terminal" && call.input.stdin === undefined && /^(git status --short|git diff --no-ext-diff|git log -5 --oneline|git rev-parse --show-toplevel)$/.test(String(call.input.command).trim())) return;
    // An attempted mutation establishes change intent even if the gate blocks it.
    this.state.intent = "change";
    this.state.broaderPolicy = "required";
    if (!this.prepared || !this.sequence.steps.length) return "workflow_preparation_required: " + this.nextAction();
    if (this.activeStep?.status !== "in_progress") return "workflow_step_required: " + this.nextAction();
  }

  verificationGate(stage: "local" | "broader"): string | undefined {
    if (!this.prepared || !this.sequence.steps.length) return "workflow_preparation_required: " + this.nextAction();
    if (stage === "local" && this.activeStep?.status !== "in_progress") return "Start or reopen a step before local verification.";
    if (stage === "broader" && (!this.sequence.steps.every(step => step.status === "verified" && step.check.epoch === this.state.epoch) || this.state.localCheck.status !== "passed" || this.state.localCheck.revision !== this.state.revision || this.state.localCheck.epoch !== this.state.epoch)) return "Verify all implementation steps before integration tests.";
  }

  plannedChecks(): Profile["verificationPolicy"]["items"] {
    const sequence = this.sequence;
    const activeIndex = sequence.steps.findIndex(step => step.id === sequence.activeStepId);
    const steps = activeIndex < 0 ? [] : sequence.steps.slice(0, activeIndex + 1);
    return [
      ...steps.flatMap((step, stepIndex) => step.verification.map((check, index) => ({ ...check, stage: "local" as const, id: `sequence-${sequence.generation}-${stepIndex}-${index}`, required: true, expectedExitCodes: [0] }))),
      ...sequence.integration.map((check, index) => ({ ...check, stage: "broader" as const, id: `integration-${sequence.generation}-${index}`, required: true, expectedExitCodes: [0] })),
    ];
  }

  override applyEffect(effect: ExecutionEffect): void {
    super.applyEffect(effect);
    if (effect.kind === "repository_write" || effect.kind === "unknown") {
      const active = this.activeStep;
      if (active?.status === "verified") {
        const index = this.sequence.steps.indexOf(active);
        this.resetFrom(index);
        this.sequence.activeStepId = active.id;
        active.status = "in_progress";
      }
      if (active) active.check = pending();
      if (this.needsChange) this.state.broaderPolicy = "required";
    }
  }

  override observe(call: ToolCall, result: ToolResult): void {
    if (call.name === "advance_workflow") return;
    super.observe(call, result);
    if (call.name === "git_diff" && this.needsChange && !this.checksCurrent()) this.state.diffRevision = -1;
  }

  override recordVerification(run: VerificationRun): void {
    if (run.epoch !== this.state.epoch || run.revision !== this.state.revision) return;
    const stage = run.stage ?? "local";
    const gate = this.verificationGate(stage);
    const expected = this.plannedChecks().filter(item => item.stage === stage);
    const matched = expected.length > 0 && expected.every(check => run.results.some(result => result.itemId === check.id && result.command === check.command && result.cwd === check.cwd && result.passed));
    if (this.needsChange && (gate || !matched) && run.passed) {
      run = { ...run, passed: false, outcome: "failed", skipReason: gate ?? "Planned verification evidence is missing." };
    }
    super.recordVerification(run);
    if (!this.sequence.steps.length) return;
    if (stage === "local" && this.activeStep?.status === "in_progress") {
      this.activeStep.check = { ...this.state.localCheck };
      if (run.passed && matched && !gate) {
        this.activeStep.status = "verified";
        this.move(this.sequence.steps.every(step => step.status === "verified") ? "integration_test" : "inspect_result", "当前步骤验证通过；" + this.nextAction());
      } else this.move("inspect_result", "当前步骤验证未通过，修复后重新验证；不能进入下一步");
    }
    if (stage === "broader") {
      this.state.diffRevision = -1;
      this.move(run.passed ? "final_review" : "inspect_result", run.passed ? "集成测试通过；读取完整 git_diff 并提交最终报告供独立评审" : "集成测试失败；定位问题并 reopen_step 修复");
    }
  }

  override checksCurrent(): boolean {
    if (!this.needsChange) return super.checksCurrent();
    return this.prepared && this.sequence.steps.length > 0 && this.sequence.steps.every(step => step.status === "verified" && step.check.epoch === this.state.epoch) && this.sequence.integration.length > 0 && super.checksCurrent();
  }

  nextAction(): string {
    if (!this.sequence.understanding) return "Use advance_workflow understand with a requirement summary and acceptance requirements, then explore the repository.";
    if (!this.prepared) return "Read/search relevant repository files, then advance_workflow architecture with a summary and fresh evidenceIds.";
    if (!this.sequence.steps.length) return "Use advance_workflow plan with ordered steps, verification commands per step, and integration commands.";
    const active = this.activeStep;
    if (active?.status === "in_progress") return `Implement/repair step ${active.id}, then run_verification stage=local with a planned command. All earlier step checks will also rerun.`;
    const next = this.sequence.steps.find(step => step.status !== "verified");
    if (next) return `Use advance_workflow start_step stepId=${next.id}.`;
    if (this.state.localCheck.status !== "passed" || this.state.localCheck.epoch !== this.state.epoch || this.state.localCheck.revision !== this.state.revision) return "Checks were invalidated by a failure or workspace change. Use reopen_step with a reason, repair and reverify that step and its successors before integration.";
    if (!this.checksCurrent()) return "Run run_verification stage=broader with a planned integration command; on failure reopen_step with a reason, repair, and reverify.";
    return "Read the complete git_diff after integration tests, check every requirement, and provide a final report for independent review. Reopen a step to address review findings.";
  }

  override projection(): Record<string, unknown> {
    const checks = (items: z.infer<typeof StepVerificationSchema>[]) => items.map(item => ({ command: item.command.slice(0, 300), cwd: item.cwd.slice(0, 200), hasStdin: item.stdin !== undefined }));
    return { ...super.projection(), sequential: {
      understanding: this.sequence.understanding.slice(0, 800), architecture: this.sequence.architecture.slice(0, 1200),
      architectureCurrent: this.sequence.architectureEpoch === this.state.epoch, activeStepId: this.sequence.activeStepId,
      steps: this.sequence.steps.map(step => ({ id: step.id, text: step.text.slice(0, 200), status: step.status, check: step.check, verification: checks(step.verification) })),
      integration: checks(this.sequence.integration),
    }, nextAction: this.nextAction() };
  }
}
