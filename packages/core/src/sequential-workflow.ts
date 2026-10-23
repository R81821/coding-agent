import { z } from "zod";
import { newId, nowIso, SequentialPlanStepSchema, SequentialWorkflowSchema, StepVerificationSchema, type Profile, type TaskExecution, type ToolCall, type VerificationRun, type WorkflowPhase } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";
import { LightweightWorkflow } from "./lightweight-workflow.js";
import { validateVerificationInput } from "./runtime-tools.js";
import { assertFileBasedVerification } from "./file-verification.js";
import type { ExecutionEffect } from "./workspace-impact.js";
import { synchronizeWorkflowTodos } from "./workflow-tasks.js";
import { missingVerificationReason, sameVerificationCwd } from "./verification-matching.js";

const text = z.string().trim().min(1).max(3000);
const stepsSchema = z.array(SequentialPlanStepSchema).min(1).max(20);
const integrationSchema = z.array(StepVerificationSchema).min(1).max(8);
const modeSchema = z.enum(["ordered", "adaptive"]);
const selectionSchema = z.enum(["manual", "autonomous"]);
type PlanStep = z.infer<typeof SequentialPlanStepSchema>;
type StoredStep = z.infer<typeof SequentialWorkflowSchema>["steps"][number];
type PlanMode = z.infer<typeof modeSchema>;
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("understand"), summary: text, requirements: z.array(text).min(1).max(20), intent: z.enum(["analysis", "change"]).default("change") }),
  z.object({ action: z.literal("architecture"), summary: text, evidenceIds: z.array(z.string()).min(1).max(20) }),
  z.object({ action: z.literal("configure"), summary: text, requirements: z.array(text).min(1).max(20), architecture: text, evidenceIds: z.array(z.string()).min(1).max(20), steps: stepsSchema, integration: integrationSchema, mode: modeSchema.default("adaptive"), selectionPolicy: selectionSchema.optional(), startStepId: z.string().optional(), reason: text.optional() }),
  z.object({ action: z.literal("plan"), steps: stepsSchema, integration: integrationSchema, mode: modeSchema.default("adaptive"), selectionPolicy: selectionSchema.optional(), reason: text.optional() }),
  z.object({ action: z.literal("update_plan"), steps: stepsSchema.optional(), removeStepIds: z.array(z.string()).max(20).optional(), integration: integrationSchema.optional(), mode: modeSchema.optional(), selectionPolicy: selectionSchema.optional(), reason: text }),
  z.object({ action: z.literal("select_next"), stepId: z.string().optional(), reason: text.optional() }),
  z.object({ action: z.literal("start_step"), stepId: z.string() }),
  z.object({ action: z.literal("reopen_step"), stepId: z.string(), reason: text }),
]);
// Providers require an object at the root. Publish the union's fields as optional parameters;
// inputSchema still enforces each action's required fields before any state change.
const actionSchemas = inputSchema.options.map(option => z.toJSONSchema(option, { io: "input" }));
const workflowInputSchema = {
  type: "object",
  properties: {
    ...Object.assign({}, ...actionSchemas.map(schema => schema.properties)),
    action: { type: "string", enum: inputSchema.options.map(option => option.shape.action.value) },
  },
  required: ["action"],
  additionalProperties: false,
};
const reconTools = new Set(["read_file", "read_range", "search_files", "search_text", "list_files", "repository_map", "search_symbol", "find_references"]);
class EvidenceGateError extends Error {
  constructor(readonly evidenceErrors: { id: string; reason: string; recovery: string }[]) {
    super("Architecture requires fresh successful repository evidence: " + evidenceErrors.map(item => `${item.id}: ${item.reason}`).join("; "));
  }
}
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
    if ((this.state.behaviorPolicyVersion === 1 && this.needsChange) || this.sequence.steps.length) this.state.broaderPolicy = "required";
    synchronizeWorkflowTodos(this.state);
  }

  override move(phase: WorkflowPhase, detail: string): void {
    synchronizeWorkflowTodos(this.state);
    super.move(phase, detail);
  }

  private get graphRequired() { return this.state.behaviorPolicyVersion === 1 || this.sequence.steps.length > 0; }
  private get sequence() { return this.state.sequential!; }
  private get activeStep() { return this.sequence.steps.find(step => step.id === this.sequence.activeStepId); }
  private get prepared() { return !!this.sequence.understanding && !!this.sequence.architecture && this.sequence.architectureEpoch === this.state.epoch; }
  private dependencies(step: PlanStep, steps: PlanStep[] = this.sequence.steps, mode: PlanMode = this.sequence.mode): string[] {
    return mode === "ordered" ? [...new Set([...steps.slice(0, steps.findIndex(item => item.id === step.id)).map(item => item.id), ...step.dependsOn ?? []])] : step.dependsOn ?? [];
  }
  private ready(step: PlanStep): boolean {
    return this.dependencies(step).every(id => this.sequence.steps.some(item => item.id === id && item.status === "verified" && item.check.status === "passed" && !!item.check.runId && item.check.epoch === this.state.epoch));
  }
  taskDispatchReady(): boolean { return this.prepared && this.state.effect !== "unknown"; }
  availableTaskSteps(): StoredStep[] {
    const running = new Set(this.sequence.taskExecutions.filter(task => ["blocked", "queued", "running", "awaiting_integration"].includes(task.status)).map(task => task.stepId));
    const depths = new Map<string, number>();
    const depth = (id: string): number => {
      if (!depths.has(id)) depths.set(id, 1 + Math.max(0, ...this.sequence.steps.filter(step => this.dependencies(step).includes(id)).map(step => depth(step.id))));
      return depths.get(id)!;
    };
    return this.sequence.steps.filter(step => step.status !== "verified" && !running.has(step.id) && this.ready(step))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || depth(b.id) - depth(a.id) || this.sequence.steps.indexOf(a) - this.sequence.steps.indexOf(b));
  }
  selectNext(stepId?: string): string {
    if (!this.prepared || !this.sequence.steps.length) throw new Error("Prepare a current task graph before selecting work.");
    const candidates = this.availableTaskSteps();
    const selected = stepId ? candidates.find(step => step.id === stepId) : candidates.find(step => step.status === "pending") ?? candidates[0];
    if (!selected) throw new Error("No eligible task: wait for running tasks, verify prerequisites or repair the graph.");
    if (this.activeStep?.id !== selected.id || selected.status === "pending") this.advance({ action: "start_step", stepId: selected.id });
    return selected.id;
  }
  beginTasks(stepIds?: string[], reason?: string): Array<{ id: string; stepId: string; prompt: string; mode: "read" | "write"; writePaths?: string[] }> {
    if (!this.prepared || this.state.effect === "unknown") throw new Error("Prepare the task graph and inspect unknown execution effects before dispatching tasks.");
    const available = this.availableTaskSteps();
    const ids = stepIds ?? available.filter(step => step.execution && !this.sequence.taskExecutions.some(task => task.stepId === step.id)).slice(0, 8).map(step => step.id);
    if (!ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error("Select 1-8 unique eligible task nodes with execution definitions.");
    const steps = ids.map(id => available.find(step => step.id === id));
    if (steps.some(step => !step?.execution)) throw new Error("Every dispatched step must be eligible and define execution.mode and its scope.");
    if (!reason && this.sequence.taskExecutions.some(task => ids.includes(task.stepId) && task.status === "interrupted")) throw new Error("Interrupted tasks require an explicit retry reason after inspecting saved artifacts; unknown writes are never replayed automatically.");
    const tasks = steps.map(step => ({ id: newId("task"), stepId: step!.id, prompt: step!.execution!.prompt ?? `${step!.text}\nAcceptance requirements: ${this.state.requirements.join("; ")}\nArchitecture: ${this.sequence.architecture}\nWork only within this node; return incremental changes. The parent will integrate and verify them.`, mode: step!.execution!.mode, ...(step!.execution!.writePaths ? { writePaths: step!.execution!.writePaths } : {}) }));
    if (tasks.some(task => task.mode === "write")) this.state.intent = "change";
    for (const task of tasks) {
      const step = this.sequence.steps.find(item => item.id === task.stepId)!;
      step.status = "in_progress"; step.check = pending();
      this.sequence.taskExecutions = this.sequence.taskExecutions.filter(item => item.stepId !== step.id);
      this.sequence.taskExecutions.push({ taskId: task.id, stepId: task.stepId, mode: task.mode, status: "running", startedAt: nowIso(), ...(task.writePaths ? { writePaths: task.writePaths } : {}) });
    }
    this.sequence.activeStepId ||= tasks[0]!.stepId;
    this.state.localCheck = pending(); this.state.localRevision = -1;
    this.clearRequirementAcceptance();
    this.move("small_edit", `调度 ${tasks.length} 个任务节点；子任务产物需在父任务合并并实测`);
    return tasks;
  }
  recordTask(task: TaskExecution): void {
    if (!this.sequence.steps.some(step => step.id === task.stepId)) throw new Error("Unknown graph step for task execution.");
    const existing = this.sequence.taskExecutions.find(item => item.taskId === task.taskId);
    if (!existing) throw new Error("Task was not dispatched by this graph.");
    if (existing.stepId !== task.stepId || existing.mode !== task.mode || (existing.childRunId && existing.childRunId !== task.childRunId)) throw new Error("Task execution identity cannot be changed after dispatch.");
    if (task.childRunId && !existing.childRunId && JSON.stringify(task.writePaths) !== JSON.stringify(existing.writePaths)) throw new Error("Child execution must use the node's dispatched write scope.");
    if ((existing.workspacePath && task.workspacePath && existing.workspacePath !== task.workspacePath) || (existing.baselineTree && task.baselineTree && existing.baselineTree !== task.baselineTree) || (task.writePaths && JSON.stringify(task.writePaths) !== JSON.stringify(existing.writePaths))) throw new Error("Task artifact baseline and write scope cannot be changed after dispatch.");
    if (existing.status !== "running") throw new Error("Settled task records cannot be replayed or overwritten; dispatch a new task explicitly.");
    Object.assign(existing, task);
    this.move(task.status === "running" ? "small_edit" : "inspect_result", `任务 ${task.stepId}：${task.status}；节点通过状态由父任务实际测试决定`);
  }
  private checkEvidence(ids: string[]): void {
    const errors = ids.flatMap(id => {
      const item = this.state.observations.find(candidate => candidate.id === id);
      const reason = !item ? "missing" : !reconTools.has(item.tool) ? "unsupported_tool" : item.failed ? "read_failed" : !item.complete ? "output_truncated" : item.epoch !== this.state.epoch || item.revision !== this.state.revision ? "version_mismatch" : undefined;
      return reason ? [{ id, reason, recovery: reason === "output_truncated" ? "Read a smaller requested range within the output budget, or use read_evidence to inspect the saved output without re-reading the file." : "Cite an existing successful repository observation from the current epoch and code revision, or inspect only the missing/changed scope." }] : [];
    });
    if (errors.length) throw new EvidenceGateError(errors);
  }
  private validatePlan(steps: PlanStep[], integration: z.infer<typeof StepVerificationSchema>[], mode: PlanMode): void {
    stepsSchema.parse(steps);
    integrationSchema.parse(integration);
    const ids = new Set(steps.map(step => step.id));
    if (ids.size !== steps.length) throw new Error("Step IDs must be unique.");
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error("Step dependencies must not contain a cycle.");
      if (visited.has(id)) return;
      visiting.add(id);
      const step = steps.find(item => item.id === id)!;
      if (new Set(step.dependsOn).size !== (step.dependsOn?.length ?? 0)) throw new Error("Step dependencies must be unique.");
      for (const dependency of this.dependencies(step, steps, mode)) {
        if (!ids.has(dependency) || dependency === id) throw new Error("Unknown or self-referencing step dependency: " + dependency);
        visit(dependency);
      }
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    for (const check of [...steps.flatMap(step => step.verification), ...integration]) {
      validateVerificationInput(check); assertFileBasedVerification(check);
    }
  }
  private affectedSteps(ids: Set<string>, steps: PlanStep[] = this.sequence.steps, mode: PlanMode = this.sequence.mode): Set<string> {
    const affected = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) if (!affected.has(step.id) && this.dependencies(step, steps, mode).some(id => affected.has(id))) { affected.add(step.id); changed = true; }
    }
    return affected;
  }
  private validateRunningTasks(steps: PlanStep[], mode: PlanMode): void {
    for (const task of this.sequence.taskExecutions.filter(item => item.status === "running")) {
      const old = this.sequence.steps.find(step => step.id === task.stepId)!;
      const next = steps.find(step => step.id === task.stepId);
      if (!next || old.text !== next.text || old.priority !== next.priority || JSON.stringify(old.execution) !== JSON.stringify(next.execution) || JSON.stringify(old.verification) !== JSON.stringify(next.verification) || JSON.stringify(this.dependencies(old).slice().sort()) !== JSON.stringify(this.dependencies(next, steps, mode).slice().sort())) throw new Error("Wait for running graph tasks before changing or removing their node definitions.");
    }
  }
  /** All validation precedes this commit; unchanged test contracts retain their real receipts. */
  private commitPlan(steps: PlanStep[], integration: z.infer<typeof StepVerificationSchema>[], mode: PlanMode): void {
    const sequence = this.sequence;
    this.validateRunningTasks(steps, mode);
    const changed = new Set(steps.filter(step => {
      const old = sequence.steps.find(item => item.id === step.id);
      return !old || JSON.stringify(old.verification) !== JSON.stringify(step.verification) || JSON.stringify(this.dependencies(old).slice().sort()) !== JSON.stringify(this.dependencies(step, steps, mode).slice().sort());
    }).map(step => step.id));
    const affected = this.affectedSteps(changed, steps, mode);
    const integrationChanged = JSON.stringify(sequence.integration) !== JSON.stringify(integration);
    const localChanged = affected.size > 0 || sequence.steps.some(step => !steps.some(item => item.id === step.id));
    if (integrationChanged) sequence.generation++;
    sequence.steps = steps.map(step => {
      const old = sequence.steps.find(item => item.id === step.id);
      return { ...step, verificationKey: old && !affected.has(step.id) ? old.verificationKey ?? `sequence-${sequence.generation}-${sequence.steps.indexOf(old)}` : newId("step"), status: old && !affected.has(step.id) ? old.status : "pending", check: old && !affected.has(step.id) ? old.check : pending() };
    });
    sequence.integration = integration;
    sequence.mode = mode;
    if (!sequence.steps.some(step => step.id === sequence.activeStepId && step.status !== "pending")) sequence.activeStepId = "";
    if (localChanged) { this.state.localCheck = pending(); this.state.localRevision = -1; }
    if (integrationChanged) { this.state.broaderCheck = pending(); this.state.broaderRevision = -1; }
    delete sequence.patchRecovery;
    this.clearRequirementAcceptance();
    this.state.plan = steps.map(step => step.text);
    if (this.state.behaviorPolicyVersion === 1) this.state.intent = "change";
    this.state.broaderPolicy = "required";
  }
  private resetFrom(index: number): void {
    for (const step of this.sequence.steps.slice(index)) { step.status = "pending"; step.check = pending(); }
    this.sequence.activeStepId = "";
    this.invalidate();
  }

  planningTool(): ToolDefinition {
    return {
      contract: { name: "advance_workflow", description: "Configure an adaptive task graph atomically with summary, requirements, architecture, current complete repository evidenceIds, steps, integration and optional startStepId. Compatible understand/architecture/plan actions remain. Auto mode can declare analysis intent before writes. dependsOn lists real prerequisites; independent nodes can start/switch freely and share a local suite batch. New adaptive plans default selectionPolicy=autonomous: before a write, runtime can select eligible work when none is active. select_next accepts any eligible stepId; omit it to recommend by priority and critical path. Set priority and optional execution mode/prompt/writePaths to enable run_tasks child concurrency. mode=ordered or selectionPolicy=manual preserves explicit selection. update_plan requires reason and supports node upserts, removeStepIds, integration, mode and selectionPolicy; unchanged test/dependency contracts retain receipts. Running node definitions cannot change. reopen_step repairs a node and dependent successors. Use real test files and project suites; dependencyPaths adds test inputs, never certifies incomplete coverage. Integration may run early. Writes require current global evidence, but unchanged complete dependencies can reuse real saved passing tests. Completion requires all nodes verified, current local/integration results and per-requirement acceptance. Plans, scheduling and child completion grant no permissions and cannot mark tests passed.", inputSchema: workflowInputSchema, strict: false, risk: "read", idempotent: false, timeoutMs: 1000 },
      handlesInputValidation: true,
      execute: async input => {
        try { this.advance(input); return { output: this.projection() }; }
        catch (error) {
          const invalidFields = error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message, ...(issue.code === "too_big" ? { limit: issue.maximum, actual: typeof input[issue.path[0] as string] === "string" ? (input[issue.path[0] as string] as string).trim().length : undefined } : {}) })) : undefined;
          return { isError: true, output: { code: invalidFields ? "workflow_input_invalid" : "workflow_gate_rejected", error: String(error), ...(invalidFields ? { invalidFields } : {}), ...(error instanceof EvidenceGateError ? { evidenceErrors: error.evidenceErrors } : {}), nextAction: invalidFields ? "Correct only the reported input fields; length errors do not require new file reads." : this.nextAction() } };
        }
      },
    };
  }

  advance(input: Record<string, unknown>): void {
    const value = inputSchema.parse(input);
    if (this.state.taskMode === "analysis") throw new Error("Analysis tasks do not enter the implementation workflow.");
    const sequence = this.sequence;
    if (value.action === "understand") {
      if (sequence.steps.length) throw new Error("Keep the accepted requirements while repairing or revising a plan.");
      if (value.intent === "analysis" && (this.state.taskMode !== "auto" || this.state.revision > 0 || this.state.effect === "unknown")) throw new Error("A change task, existing change plan or unconfirmed write cannot be downgraded to analysis.");
      sequence.understanding = value.summary;
      sequence.understoodAt = this.state.observationSequence;
      sequence.architecture = "";
      sequence.architectureEpoch = "";
      this.state.requirements = value.requirements;
      this.state.requirementIds = value.requirements.map((_, index) => `req-${index + 1}`);
      this.clearRequirementAcceptance();
      this.state.intent = value.intent;
      if (value.intent === "change" && this.state.behaviorPolicyVersion === 1) this.state.broaderPolicy = "required";
      this.move("repository_recon", "已记录需求；探索相关文件、入口和测试");
      return;
    }
    if (value.action === "architecture") {
      if (!sequence.understanding) throw new Error("Record understand before architecture.");
      this.checkEvidence(value.evidenceIds);
      sequence.architecture = value.summary;
      sequence.architectureEpoch = this.state.epoch;
      sequence.evidenceIds = value.evidenceIds;
      this.state.context = value.summary;
      this.move("identify_architecture", "已记录模块职责、依赖和变更边界；制定分步计划");
      return;
    }
    if (value.action === "configure") {
      this.checkEvidence(value.evidenceIds);
      this.validatePlan(value.steps, value.integration, value.mode);
      this.validateRunningTasks(value.steps, value.mode);
      if (sequence.steps.length && (!value.reason || JSON.stringify(this.state.requirements) !== JSON.stringify(value.requirements))) throw new Error("Reconfiguring an accepted plan requires a reason and unchanged acceptance requirements.");
      const selected = value.startStepId ? value.steps.find(step => step.id === value.startStepId) : undefined;
      if (value.startStepId && (!selected || this.dependencies(selected, value.steps, value.mode).length > 0)) throw new Error("configure startStepId must identify a step without prerequisites; start dependent steps after their real verification.");
      sequence.understanding = value.summary;
      sequence.understoodAt = this.state.observationSequence;
      sequence.architecture = value.architecture;
      sequence.architectureEpoch = this.state.epoch;
      sequence.evidenceIds = value.evidenceIds;
      this.state.context = value.architecture;
      this.state.requirements = value.requirements;
      this.state.requirementIds = value.requirements.map((_, index) => `req-${index + 1}`);
      this.commitPlan(value.steps, value.integration, value.mode);
      sequence.selectionPolicy = value.selectionPolicy ?? (value.mode === "adaptive" ? "autonomous" : "manual");
      if (selected) {
        this.state.intent = "change";
        const step = this.sequence.steps.find(item => item.id === selected.id)!;
        if (step.status === "pending") { step.status = "in_progress"; step.check = pending(); }
        sequence.activeStepId = step.id;
      }
      this.move(selected ? "small_edit" : "plan_hypothesis", "需求、架构和计划已原子更新；按依赖选择步骤，实际测试决定通过状态");
      return;
    }
    if (!this.prepared) throw new Error("Understand the requirement and identify architecture using current repository evidence first.");
    if (value.action === "plan" || value.action === "update_plan") {
      if (value.action === "plan" && sequence.steps.length && !value.reason) throw new Error("Revising a plan requires a reason.");
      if (value.action === "update_plan" && !sequence.steps.length) throw new Error("Create a plan before updating it.");
      const mode = value.mode ?? sequence.mode;
      const integration = value.integration ?? sequence.integration;
      let steps: PlanStep[];
      if (value.action === "update_plan") {
        const removed = new Set(value.removeStepIds ?? []);
        if ([...removed].some(id => !sequence.steps.some(step => step.id === id))) throw new Error("removeStepIds must refer to existing steps.");
        const upserts = (value.steps ?? []).map(step => {
          const old = sequence.steps.find(item => item.id === step.id);
          return { ...step, dependsOn: step.dependsOn ?? old?.dependsOn, priority: step.priority ?? old?.priority, execution: step.execution ?? old?.execution };
        });
        if (upserts.some(step => removed.has(step.id))) throw new Error("A step cannot be updated and removed in the same request.");
        steps = [...upserts, ...sequence.steps.filter(step => !removed.has(step.id) && !upserts.some(item => item.id === step.id)).map(({ status: _status, check: _check, verificationKey: _key, ...step }) => step)];
      } else steps = value.steps;
      this.validatePlan(steps, integration, mode);
      this.commitPlan(steps, integration, mode);
      sequence.selectionPolicy = value.selectionPolicy ?? (value.action === "plan" ? mode === "adaptive" ? "autonomous" : "manual" : sequence.selectionPolicy);
      this.move("plan_hypothesis", "计划已更新；保留未受影响的真实验证，按依赖选择实施步骤");
      return;
    }
    if (value.action === "select_next") { this.selectNext(value.stepId); return; }
    const index = sequence.steps.findIndex(step => step.id === value.stepId);
    if (index < 0) throw new Error("Unknown stepId; use a step from the implementation plan.");
    if (!this.ready(sequence.steps[index]!)) throw new Error("Verify every previous step or explicit dependency before starting this step.");
    if (value.action === "reopen_step") {
      const affected = this.affectedSteps(new Set([value.stepId]));
      for (const step of sequence.steps) if (affected.has(step.id)) { step.status = "pending"; step.check = pending(); }
      this.invalidate();
    }
    else if (sequence.mode === "ordered" && this.activeStep?.status === "in_progress" && this.activeStep.id !== value.stepId) throw new Error("The current step must pass verification first.");
    else if (sequence.steps[index]!.status === "verified") throw new Error("Use reopen_step with a reason to change a verified step.");
    const step = sequence.steps[index]!;
    this.state.intent = "change";
    delete sequence.patchRecovery;
    sequence.activeStepId = step.id;
    step.status = "in_progress";
    step.check = pending();
    // Selecting work is not a repository mutation. A new started step expands the local test
    // obligation; real writes still invalidate all global evidence through applyEffect.
    this.state.localCheck = pending(); this.state.localRevision = -1;
    this.clearRequirementAcceptance();
    this.move("small_edit", `实施步骤 ${index + 1}/${sequence.steps.length}：${step.text}`);
  }

  override before(call: ToolCall, tool: ToolDefinition): string | undefined {
    const base = super.before(call, tool);
    if (base || this.state.taskMode === "analysis") return base;
    // Browser interaction has its own permission gate; it is not repository implementation.
    if (call.name === "browser") return;
    if (call.name === "run_tasks") return this.prepared && this.state.effect !== "unknown" ? undefined : "Prepare the graph and inspect unknown effects before running tasks.";
    if (call.name === "run_verification") return this.verificationGate(call.input.stage === "broader" ? "broader" : "local");
    const risk = tool.assessRisk?.(call.input) ?? tool.contract.risk;
    if (risk === "read" && call.name !== "delegate") return;
    if (call.name === "terminal" && call.input.stdin === undefined && /^(git status --short|git diff --no-ext-diff|git log -5 --oneline|git rev-parse --show-toplevel)$/.test(String(call.input.command).trim())) return;
    // Risk and permission are checked independently. A blocked attempt is not a write.
    if (this.state.behaviorPolicyVersion === 2 && (call.name === "terminal" || call.name === "probe")) return;
    if (!this.graphRequired) return;
    if (this.state.behaviorPolicyVersion === 1) this.state.intent = "change";
    this.state.broaderPolicy = "required";
    if (!this.prepared || !this.sequence.steps.length) return "workflow_preparation_required: " + this.nextAction();
    if (this.activeStep?.status !== "in_progress" && this.sequence.selectionPolicy === "autonomous" && this.availableTaskSteps().length) this.selectNext();
    if (this.activeStep?.status !== "in_progress") return "workflow_step_required: " + this.nextAction();
  }

  verificationGate(stage: "local" | "broader"): string | undefined {
    if (!this.needsChange || !this.graphRequired) return;
    if (!this.prepared || !this.sequence.steps.length) return "workflow_preparation_required: " + this.nextAction();
    if (this.sequence.taskExecutions.some(task => task.status === "running" || task.status === "awaiting_integration")) return "Wait for running graph tasks and integrate their results before recording parent verification.";
    if (stage === "local" && !this.activeStep) return "Start or reopen a step before local verification.";
    if (stage === "broader" && this.sequence.mode === "ordered" && (!this.sequence.steps.every(step => step.status === "verified" && step.check.epoch === this.state.epoch) || this.state.localCheck.status !== "passed" || this.state.localCheck.revision !== this.state.revision || this.state.localCheck.epoch !== this.state.epoch)) return "Verify all implementation steps before integration tests.";
  }

  plannedChecks(): Profile["verificationPolicy"]["items"] {
    const sequence = this.sequence;
    const activeIndex = sequence.steps.findIndex(step => step.id === sequence.activeStepId);
    const steps = sequence.mode === "adaptive" ? sequence.steps.filter(step => step.status !== "pending") : activeIndex < 0 ? [] : sequence.steps.slice(0, activeIndex + 1);
    return [
      ...steps.flatMap(step => step.verification.map((check, index) => ({ ...check, stage: "local" as const, id: `${step.verificationKey ?? `sequence-${sequence.generation}-${sequence.steps.indexOf(step)}`}-${index}`, required: true, expectedExitCodes: [0] }))),
      ...sequence.integration.map((check, index) => ({ ...check, stage: "broader" as const, id: `integration-${sequence.generation}-${index}`, required: true, expectedExitCodes: [0] })),
    ];
  }

  override applyEffect(effect: ExecutionEffect): void {
    super.applyEffect(effect);
    if (effect.kind === "repository_write" || effect.kind === "unknown") {
      delete this.sequence.patchRecovery;
      const active = this.activeStep;
      if (active?.status === "verified") {
        const affected = this.affectedSteps(new Set([active.id]));
        for (const step of this.sequence.steps) if (affected.has(step.id)) { step.status = "pending"; step.check = pending(); }
        this.sequence.activeStepId = active.id;
        active.status = "in_progress";
      }
      if (active) active.check = pending();
      if (this.needsChange && this.graphRequired) this.state.broaderPolicy = "required";
    }
  }

  override observe(call: ToolCall, result: ToolResult): void {
    if (call.name === "advance_workflow") return;
    super.observe(call, result);
    if (["patch", "apply_patch"].includes(call.name)) {
      delete this.sequence.patchRecovery;
      const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : undefined;
      const diagnostic = output?.diagnostic && typeof output.diagnostic === "object" ? output.diagnostic as Record<string, unknown> : undefined;
      // Validation failures do not modify the repository. Formatting can be repaired using the
      // accepted plan and current source; only a content conflict needs a bounded context refresh.
      if (result.isError && output?.applied === false && output.phase === "validation" &&
          (diagnostic?.kind === "format" || diagnostic?.kind === "conflict") &&
          this.state.effect !== "unknown" && this.state.effect !== "repository_write") {
        this.sequence.patchRecovery = {
          callId: call.id, kind: diagnostic.kind,
          paths: Array.isArray(diagnostic.paths) ? diagnostic.paths.filter((path): path is string => typeof path === "string").slice(0, 20).map(path => path.slice(0, 300)) : [],
          contextReadRequired: diagnostic.kind === "conflict",
        };
        this.move("small_edit", diagnostic.kind === "format" ? "补丁格式错误；保留当前计划和源码证据，修正补丁后直接重试，无需重新读取文件" : "补丁内容冲突；仅重新读取冲突文件的相关范围，修正后重试");
      }
    } else if (this.sequence.patchRecovery?.contextReadRequired && !result.isError && !result.truncated &&
        ["read_file", "read_range"].includes(call.name) && typeof call.input.path === "string" &&
        this.sequence.patchRecovery.paths.some(path => path.replaceAll("\\", "/") === String(call.input.path).replaceAll("\\", "/"))) {
      this.sequence.patchRecovery.contextReadRequired = false;
      this.move("small_edit", "已取得冲突范围的当前内容；复用该证据修正补丁并重试，无需再次读取文件");
    }
    // A complete current diff may precede a test run. Acceptance decides whether its runtime
    // fingerprint matches the test receipts; ordering alone is not a content change.
  }

  override recordVerification(run: VerificationRun): void {
    if (!this.graphRequired) { super.recordVerification(run); return; }
    if (run.epoch !== this.state.epoch || run.revision !== this.state.revision) return;
    const stage = run.stage ?? "local";
    const gate = this.verificationGate(stage);
    const expected = this.plannedChecks().filter(item => item.stage === stage);
    const missing = expected.filter(check => !run.results.some(result => result.itemId === check.id && result.command === check.command && sameVerificationCwd(result.cwd, check.cwd) && result.passed));
    const matched = expected.length > 0 && missing.length === 0;
    if (this.needsChange && (gate || !matched) && run.passed) {
      Object.assign(run, { passed: false, outcome: "failed", skipReason: gate ?? missingVerificationReason(missing) });
    }
    super.recordVerification(run);
    if (!this.sequence.steps.length) return;
    if (stage === "local" && this.activeStep) {
      const covered = this.sequence.mode === "adaptive" ? this.sequence.steps.filter(step => step.status !== "pending") : this.sequence.steps.slice(0, this.sequence.steps.indexOf(this.activeStep) + 1);
      for (const step of covered) {
        step.check = { ...this.state.localCheck };
        step.status = run.passed && matched && !gate ? "verified" : "in_progress";
      }
      if (run.passed && matched && !gate) {
        this.move(this.sequence.steps.every(step => step.status === "verified") ? "integration_test" : "inspect_result", "已启动步骤的实际测试通过；" + this.nextAction());
      } else this.move("inspect_result", "实际测试未通过；优化代码或测试，再运行套件；可以继续无依赖步骤");
    }
    if (stage === "broader") {
      this.move(run.passed ? "requirements_check" : "inspect_result", run.passed ? "集成测试通过；所有步骤完成后，使用当前测试和完整 diff 逐项验收；相同指纹的已有 diff 可复用" : "集成测试失败；定位问题，修复代码或测试后重跑");
    }
  }

  override checksCurrent(): boolean {
    if (!this.needsChange || !this.graphRequired) return super.checksCurrent();
    return this.prepared && !this.sequence.taskExecutions.some(task => ["blocked", "queued", "running", "awaiting_integration"].includes(task.status)) && this.sequence.steps.length > 0 && this.sequence.steps.every(step => step.status === "verified" && step.check.status === "passed" && step.check.epoch === this.state.epoch && step.check.revision === this.state.revision) && this.sequence.integration.length > 0 && super.checksCurrent();
  }

  nextAction(): string {
    if (this.state.effect === "unknown") return "Inspect the unconfirmed execution effect with complete current workspace_diff; unknown effects cannot be reported as unchanged.";
    if (!this.graphRequired) {
      if (!this.needsChange && this.state.explicitRequirementAcceptance && this.state.requirementsRevision !== this.state.revision) return "Correct check_requirements using complete current observations for the read-only request; tests and diff are optional.";
      if (!this.needsChange) return "Answer the user's question using relevant evidence. Tools, tests, repository exploration and a graph are needed only when the question requires them.";
      if (!this.checksCurrent()) return "Run relevant persisted project checks with run_verification; fix failures. High-impact changes also require broader verification. Use advance_workflow configure only when dependencies justify a graph.";
      if (this.state.diffRevision !== this.state.revision) return "Inspect complete current workspace_diff; for documents review content, links and format.";
      if (this.state.requirementsRevision !== this.state.revision) return "Use check_requirements with current observations and diffObservationId for every requirement; include actual verificationIds for code/config changes. Plain documentation uses content and diff evidence.";
      return "Deliver the result with relevant evidence and material limitations.";
    }
    if (!this.needsChange) return this.state.requirementsRevision === this.state.revision ? "Provide the final read-only report using accepted current observations." : "Inspect the relevant repository scope, then check_requirements with complete current observationIds; read-only acceptance does not require tests or a diff.";
    if (!this.sequence.understanding) return "Use advance_workflow understand with a requirement summary and acceptance requirements, then explore the repository.";
    if (!this.prepared) return "Read/search relevant repository files, then advance_workflow architecture with a summary and fresh evidenceIds.";
    if (!this.sequence.steps.length) return "Use advance_workflow configure or plan with steps, explicit dependsOn where needed, file-based test suite commands and an integration suite. Put assertions in test files; run suites through the project's test entry point.";
    const active = this.activeStep;
    const repair = this.sequence.patchRecovery;
    const activeTask = active && this.sequence.taskExecutions.find(task => task.stepId === active.id);
    if (active?.status === "in_progress" && activeTask && activeTask.status !== "running" && activeTask.patch !== undefined) return `Inspect saved incremental artifacts with read_evidence id=${activeTask.taskId}, integrate them under the parent's permissions, then run the planned local suites. Child status ${activeTask.status} does not verify step ${active.id}. You may choose other eligible nodes while preparing integration.`;
    if (active?.status === "in_progress" && repair) {
      if (repair.contextReadRequired) return `Patch ${repair.callId} has a content conflict. Read only the affected range in ${repair.paths.join(", ") || "the target file"}, correct that hunk, and retry patch for step ${active.id}. Keep the accepted requirements, architecture and plan; do not restart repository exploration.`;
      return `Correct and retry patch for step ${active.id} using the existing current source evidence. ${repair.kind === "format" ? "The previous patch failed format validation without changing files; do not reread files or rebuild the plan just to fix headers/counts." : "The conflict range has already been refreshed; do not reread it again."} Then run_verification stage=local with the planned test suite.`;
    }
    if (active?.status === "in_progress") return this.sequence.mode === "ordered" ? `Implement/repair step ${active.id}, then run_verification stage=local with its planned suite and cumulative preceding suites. Write or update real test files; real results determine progress.` : `Implement/repair step ${active.id}, or start another available independent step, then run_verification stage=local with the planned suite command to verify all started steps together. Write or update real test files; real results determine progress.`;
    const next = this.availableTaskSteps()[0];
    if (next) return `Choose an eligible task with advance_workflow select_next; recommended stepId=${next.id} by priority and critical path. You may choose another eligible node or adjust the graph with update_plan and a reason.${next.execution && !this.sequence.taskExecutions.some(task => task.stepId === next.id) ? " Use run_tasks to execute independent nodes concurrently, then integrate their saved artifacts and run parent suites." : ""}`;
    if (this.sequence.taskExecutions.some(task => ["queued", "running", "awaiting_integration"].includes(task.status))) return "Use wait_tasks for queued/running children; inspect ready outputs with read_evidence and acknowledge integration with integrate_tasks before real parent verification.";
    if (this.state.localCheck.status !== "passed" || this.state.localCheck.epoch !== this.state.epoch || this.state.localCheck.revision !== this.state.revision) return "Checks were invalidated by a failure or workspace change; repair and reverify with run_verification stage=local. Use reopen_step with a reason when code needs repair, then rerun integration.";
    if (!this.checksCurrent()) return "Run run_verification stage=broader with a planned integration command; on failure reopen_step with a reason, repair, and reverify.";
    if (this.state.diffRevision !== this.state.revision) return "Read a complete current workspace_diff, then call check_requirements with test and diff evidence for every requirement. Reuse an existing complete diff only when its runtime fingerprint matches current passing tests.";
    if (this.state.requirementsRevision !== this.state.revision) return "Call check_requirements with every stable requirementId exactly once, passed=true, concrete summary, current observationIds, passing local and integration verificationIds, and diffObservationId. Passing suites and todo completion alone do not mark requirements accepted.";
    return "Provide the final report using the accepted current requirement, test and diff evidence. Independent model review is disabled. Reopen a step to repair code and rerun its suites when needed.";
  }

  override projection(): Record<string, unknown> {
    const availableSteps = this.availableTaskSteps().map(step => step.id);
    const completionBlockers: string[] = [];
    const suggestedActions: Array<{ action: string; reason: string; stepId?: string }> = [];
    if (this.state.effect === "unknown") { completionBlockers.push("Execution effect is unconfirmed."); suggestedActions.push({ action: "workspace_diff", reason: "Confirm repository contents before using evidence." }); }
    if (this.needsChange) {
      if (this.graphRequired && (!this.prepared || !this.sequence.steps.length)) { completionBlockers.push("Current repository evidence and an implementation plan are required."); suggestedActions.push({ action: "configure", reason: "Atomically record understanding, architecture, steps and real test suites." }); }
      for (const step of this.sequence.steps) if (step.status !== "verified") completionBlockers.push(`Step ${step.id} lacks passing runtime verification.`);
      for (const stepId of availableSteps) suggestedActions.push({ action: "start_step", stepId, reason: "Its prerequisites are verified; it can be selected or combined with independent work." });
      if (availableSteps.length) suggestedActions.push({ action: "select_next", reason: "Choose any eligible node, or omit stepId to select by priority and critical path." });
      if (this.availableTaskSteps().some(step => step.execution && !this.sequence.taskExecutions.some(task => task.stepId === step.id))) suggestedActions.push({ action: "run_tasks", reason: "Run eligible graph nodes as bounded concurrent child tasks; merge artifacts and test in the parent." });
      for (const task of this.sequence.taskExecutions.filter(item => item.status === "running")) completionBlockers.push(`Task ${task.stepId} is still running.`);
      if (this.prepared && this.sequence.steps.length) {
        if (this.activeStep) suggestedActions.push({ action: "run_verification:local", reason: "Run real suites for started steps; one suite may cover a combined batch." });
        suggestedActions.push({ action: "run_verification:broader", reason: "Inspect integration behavior; completion still requires all current step and test receipts." });
        suggestedActions.push({ action: "update_plan", reason: "Adjust affected steps while preserving unchanged verification contracts." });
      }
      if (!this.checksCurrent()) { completionBlockers.push("Current relevant verification receipts are required."); if (!this.graphRequired) suggestedActions.push({ action: "run_verification", reason: "Run checks relevant to the actual change; high-impact changes require broader verification." }); }
      if (this.state.diffRevision !== this.state.revision) { completionBlockers.push("A complete current diff is required."); suggestedActions.push({ action: "workspace_diff", reason: "Collect code evidence reusable when the runtime fingerprint stays unchanged." }); }
    }
    if ((this.needsChange || this.state.explicitRequirementAcceptance) && this.state.requirementsRevision !== this.state.revision) { completionBlockers.push("Every acceptance requirement needs current evidence."); suggestedActions.push({ action: "check_requirements", reason: this.needsChange ? "Cite actual current tests and complete diff evidence after prerequisites pass." : "Cite complete current reads or probes; tests and diff are optional." }); }
    if (!completionBlockers.length) suggestedActions.push({ action: "final_report", reason: "Runtime evidence is current; submit one final report." });
    const checks = (items: z.infer<typeof StepVerificationSchema>[]) => items.map(item => ({ command: item.command.slice(0, 300), cwd: item.cwd.slice(0, 200), hasStdin: item.stdin !== undefined }));
    return { ...super.projection(), sequential: {
      understanding: this.sequence.understanding.slice(0, 800), architecture: this.sequence.architecture.slice(0, 1200),
      architectureCurrent: this.sequence.architectureEpoch === this.state.epoch, activeStepId: this.sequence.activeStepId, mode: this.sequence.mode, selectionPolicy: this.sequence.selectionPolicy,
      taskExecutions: this.sequence.taskExecutions.map(({ patch, ...task }) => ({ ...task, summary: task.summary?.slice(0, 600), hasPatch: patch !== undefined })),
      ...(this.sequence.patchRecovery ? { patchRecovery: this.sequence.patchRecovery } : {}),
      steps: this.sequence.steps.map(step => ({ id: step.id, text: step.text.slice(0, 200), priority: step.priority ?? 0, execution: step.execution ? { ...step.execution, prompt: step.execution.prompt?.slice(0, 1200) } : undefined, dependsOn: this.dependencies(step), status: step.status, check: step.check, verification: checks(step.verification) })),
      integration: checks(this.sequence.integration),
    }, availableSteps, suggestedActions, completionBlockers, nextAction: this.nextAction() };
  }
}
