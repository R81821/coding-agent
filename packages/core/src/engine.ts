import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  AgentEvent,
  AgentEventInput,
  ModelMessage,
  PlanSpec,
  Profile,
  RunCheckpoint,
  RunSpec,
  RunStatus,
  ToolCall,
  VerificationRun,
} from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";
import { ModelRouter } from "@harness/providers";
import type { MemoryService, SkillService } from "@harness/extensions";
import type { HarnessDatabase } from "@harness/persistence";
import type { ToolRegistry } from "@harness/tools";
import { ApprovalBroker } from "./approvals.js";
import { buildInitialMessages } from "./context.js";
import { runWithPiAgent } from "./pi-agent-bridge.js";
import { PermissionEngine, summarizeToolRequest } from "./security.js";
import type { ProjectTrustService } from "./project-trust.js";

const transitions: Record<RunStatus, RunStatus[]> = {
  queued: ["planning", "cancelled", "failed"],
  planning: ["running", "failed", "cancelled"],
  running: [
    "waiting_approval",
    "verifying",
    "review",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_approval: ["running", "paused", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed"],
  verifying: ["running", "review", "completed", "failed", "cancelled"],
  review: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface EngineDependencies {
  database: HarnessDatabase;
  providers: ModelProvider[];
  tools: ToolRegistry;
  memory: MemoryService;
  skills: SkillService;
  projectTrust: ProjectTrustService;
}

function planStepFor(call: ToolCall, risk: "read" | "write" | "high" | "destructive", index: number): PlanSpec["steps"][number] {
  return {
    id: `step-${index}`,
    title: `Execute ${call.name}`,
    description: `Run ${call.name} with the normalized, visible parameters after plan and tool authorization.`,
    dependencies: index > 1 ? [`step-${index - 1}`] : [],
    executor: call.name === "delegate" ? "child" : "main",
    mode: call.name === "terminal" ? "verify" : risk === "read" ? "read" : "write",
    allowedTools: [call.name],
    input: call.input,
    outputContract: "Return structured tool output, changed paths, and any errors for review.",
    acceptanceCriteria: ["Tool scope remains within the approved plan", "Result is recorded in the run event log"],
    status: "pending",
  };
}

function scopeFor(call: ToolCall, risk: "read" | "write" | "high" | "destructive"): PlanSpec["scope"] {
  const paths = [call.input.path, call.input.filePath, call.input.cwd].filter((value): value is string => typeof value === "string");
  const commands = typeof call.input.command === "string" ? [call.input.command] : [];
  const domains: string[] = [];
  if (typeof call.input.url === "string") {
    try { domains.push(new URL(call.input.url).hostname); } catch { /* invalid URLs remain outside the approved scope */ }
  }
  return { pathGlobs: paths, commandPrefixes: commands, networkDomains: domains, maxRisk: risk };
}

function mergeScope(left: PlanSpec["scope"], right: PlanSpec["scope"]): PlanSpec["scope"] {
  const order = { read: 0, write: 1, high: 2, destructive: 3 } as const;
  return {
    pathGlobs: [...new Set([...left.pathGlobs, ...right.pathGlobs])],
    commandPrefixes: [...new Set([...left.commandPrefixes, ...right.commandPrefixes])],
    networkDomains: [...new Set([...left.networkDomains, ...right.networkDomains])],
    maxRisk: order[left.maxRisk] >= order[right.maxRisk] ? left.maxRisk : right.maxRisk,
  };
}

function planCovers(plan: PlanSpec, call: ToolCall, risk: "read" | "write" | "high" | "destructive"): boolean {
  const allowedTool = plan.steps.some((step) => step.allowedTools.includes(call.name));
  if (!allowedTool) return false;
  const proposed = scopeFor(call, risk);
  const order = { read: 0, write: 1, high: 2, destructive: 3 } as const;
  return order[plan.scope.maxRisk] >= order[proposed.maxRisk]
    && proposed.pathGlobs.every((value) => plan.scope.pathGlobs.includes("**") || plan.scope.pathGlobs.includes(value))
    && proposed.commandPrefixes.every((value) => plan.scope.commandPrefixes.some((prefix) => value.startsWith(prefix)))
    && proposed.networkDomains.every((value) => plan.scope.networkDomains.includes(value));
}

interface ActiveRun {
  spec: RunSpec;
  controller: AbortController;
  sequence: number;
  status: RunStatus;
  startedAt: number;
  toolCalls: number;
  turns: number;
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  transcript: ModelMessage[];
  plan: PlanSpec | undefined;
  pendingNonIdempotent: Map<string, ToolCall>;
  hadSideEffect: boolean;
  consecutiveToolErrors: number;
  toolRecoveryLimitReached: boolean;
}

export class HarnessEngine extends EventEmitter {
  readonly approvals: ApprovalBroker;
  private readonly permission = new PermissionEngine();
  private readonly router: ModelRouter;
  private readonly active = new Map<string, ActiveRun>();
  private readonly planDecisions = new Map<string, (decision: { approved: boolean; actor: string; feedback?: string }) => void>();
  private readonly tracer = trace.getTracer("harness-agent", "2.0.0");

  constructor(private readonly deps: EngineDependencies) {
    super();
    this.router = new ModelRouter(deps.providers);
    this.approvals = new ApprovalBroker(deps.database);
  }

  start(spec: RunSpec, profile: Profile): void {
    if (this.active.has(spec.id))
      throw new Error(`Run is already active: ${spec.id}`);
    this.deps.database.saveRun(spec, "queued");
    const state: ActiveRun = {
      spec,
      controller: new AbortController(),
      sequence: 0,
      status: "queued",
      startedAt: Date.now(),
      toolCalls: 0,
      turns: 0,
      spentUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      transcript: [],
      plan: undefined,
      pendingNonIdempotent: new Map(),
      hadSideEffect: false,
      consecutiveToolErrors: 0,
      toolRecoveryLimitReached: false,
    };
    this.active.set(spec.id, state);
    void this.execute(spec, profile, state).finally(() =>
      this.active.delete(spec.id),
    );
  }

  resume(runId: string, profile: Profile): void {
    if (this.active.has(runId)) throw new Error(`Run is already active: ${runId}`);
    const stored = this.deps.database.getRun(runId);
    if (!stored) throw new Error(`Unknown run: ${runId}`);
    const checkpoint = this.deps.database.getLatestCheckpoint(runId);
    if (!checkpoint) throw new Error(`Run has no recoverable checkpoint: ${runId}`);
    const transcript = [...checkpoint.transcript];
    for (const call of checkpoint.pendingNonIdempotentToolCalls) transcript.push({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: call.id, output: { error: "Execution state is unknown after restart. The non-idempotent call was not replayed; inspect current state before proposing a new call." }, trust: "untrusted_tool" }]
    });
    const state: ActiveRun = {
      spec: stored.spec,
      controller: new AbortController(),
      sequence: Math.max(checkpoint.sequence + 1, this.deps.database.listEvents(runId).length),
      status: "paused",
      startedAt: Date.now(),
      toolCalls: checkpoint.toolCalls,
      turns: checkpoint.turns,
      spentUsd: checkpoint.usage.estimatedUsd,
      inputTokens: checkpoint.usage.inputTokens,
      outputTokens: checkpoint.usage.outputTokens,
      transcript,
      plan: this.deps.database.getPlanForRun(runId),
      pendingNonIdempotent: new Map(),
      hadSideEffect: checkpoint.toolCalls > 0,
      consecutiveToolErrors: 0,
      toolRecoveryLimitReached: false,
    };
    this.active.set(runId, state);
    void this.execute(stored.spec, profile, state, checkpoint).finally(() => this.active.delete(runId));
  }

  decidePlan(planId: string, version: number, approved: boolean, actor: string, feedback?: string): PlanSpec {
    const plan = this.deps.database.getPlan(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    if (plan.version !== version || plan.status !== "awaiting_approval") throw new Error("Plan version is stale or is not awaiting approval");
    const resolver = this.planDecisions.get(plan.id);
    if (!resolver) throw new Error("Plan is not attached to an active run");
    resolver({ approved, actor, ...(feedback ? { feedback } : {}) });
    return plan;
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.controller.abort(new Error("Cancelled by user"));
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Budget available to a delegated child task: the parent's remaining budget
   * divided by the task divisor, with floors so a live parent never hands out
   * a zero budget. Called before the child run starts.
   */
  childBudget(parentRunId: string, divisor: number): RunSpec["budget"] {
    const parent = this.active.get(parentRunId);
    if (!parent) throw new Error(`Parent run is not active: ${parentRunId}`);
    const remainingUsd = Math.max(0, parent.spec.budget.maxUsd - parent.spentUsd);
    const remainingToolCalls = Math.max(0, parent.spec.budget.maxToolCalls - parent.toolCalls);
    const remainingMs = Math.max(0, parent.spec.budget.maxDurationMs - (Date.now() - parent.startedAt));
    return {
      maxTurns: Math.max(4, Math.floor(parent.spec.budget.maxTurns / divisor)),
      maxToolCalls: Math.max(1, Math.floor(remainingToolCalls / divisor)),
      maxDurationMs: Math.max(10_000, Math.floor(remainingMs / divisor)),
      maxUsd: Math.max(0.01, remainingUsd / divisor),
    };
  }

  /** Fold a finished child run's usage into the parent's budget. Throws when the parent budget is exceeded. */
  reportChildUsage(parentRunId: string, usage: { inputTokens: number; outputTokens: number; estimatedUsd: number }): void {
    const parent = this.active.get(parentRunId);
    if (!parent) return;
    parent.inputTokens += usage.inputTokens;
    parent.outputTokens += usage.outputTokens;
    parent.spentUsd += usage.estimatedUsd;
    this.checkBudget(parent.spec, parent);
  }

  recoverInterrupted(): string[] {
    const recovered = [];
    for (const { spec } of this.deps.database.listInterruptedRuns()) {
      const checkpoint = this.deps.database.getLatestCheckpoint(spec.id);
      this.deps.database.updateRunStatus(spec.id, checkpoint?.pendingNonIdempotentToolCalls.length ? "waiting_approval" : "paused");
      recovered.push(spec.id);
    }
    return recovered;
  }

  private async execute(
    spec: RunSpec,
    profile: Profile,
    state: ActiveRun,
    recovery?: RunCheckpoint,
  ): Promise<void> {
    try {
      if (recovery) {
        this.status(spec.id, state, "running");
        this.emitEvent(spec.id, state, { type: "recovery_event", checkpointId: recovery.id, action: recovery.pendingNonIdempotentToolCalls.length ? "paused_non_idempotent" : "restored", detail: recovery.pendingNonIdempotentToolCalls.length ? "Restored transcript with unknown non-idempotent calls marked as not replayed." : "Restored exact transcript, plan version and budgets from the latest checkpoint." });
      } else this.status(spec.id, state, "planning");
      const memories = this.deps.memory.retrieve(
        spec.request,
        spec.sessionId,
        spec.workspacePath,
        profile.memoryScopes,
      );
      const discoveredSkills = await this.deps.skills.discover(
        spec.workspacePath,
      );
      const registeredSkills = new Map(
        this.deps.database
          .listSkills()
          .map((skill) => [skill.sourcePath, skill]),
      );
      const skillDocuments = await Promise.all(
        discoveredSkills.map((skill) => {
          const registered = registeredSkills.get(skill.manifest.sourcePath);
          return registered?.trustedHash
            ? this.deps.skills.load(
                skill.manifest.sourcePath,
                registered.trustedHash,
              )
            : skill;
        }),
      );
      const trustedSkills = skillDocuments.filter(
        (skill) =>
          skill.manifest.enabled &&
          profile.skillIds.includes(skill.manifest.id),
      );
      const trustedProjectInstructions =
        await this.deps.projectTrust.loadInstructions(spec.workspacePath);
      const messages = buildInitialMessages({
        run: spec,
        profile,
        memories,
        trustedSkills,
        ...(trustedProjectInstructions ? { trustedProjectInstructions } : {}),
      });
      const contracts = this.deps.tools.contracts(profile.toolNames);
      const requirements = {
        needsVision: spec.attachments.length > 0,
        needsTools: contracts.length > 0,
        needsStructuredOutput: false,
        estimatedInputTokens: Math.max(
          512,
          Math.ceil(JSON.stringify(messages).length / 4),
        ),
        estimatedOutputTokens: 4_096,
      };
      const route = await this.router.route(profile, requirements);
      this.emitEvent(spec.id, state, {
        type: "route",
        providerId: route.provider.id,
        modelId: route.model.modelId,
        reason: route.reason,
        estimatedUsd: route.estimatedUsd,
      });
      if (!recovery) this.status(spec.id, state, "running");
      let finalText = "";
      let turnLimitReached = false;
      let recoveryLimitReached = false;
      const resiliencePolicy = profile.resiliencePolicy ?? {
        maxProviderAttempts: 3,
        providerRetryBaseDelayMs: 500,
        maxToolSelfCorrections: 3,
      };
      const bridgeResult = await runWithPiAgent({
        runId: spec.id,
        sessionId: spec.sessionId,
        provider: route.provider,
        model: route.model,
        initialMessages: messages,
        contracts,
        resolveTool: (name) => this.deps.tools.get(name),
        externalSignal: state.controller.signal,
        maxOutputTokens: Math.min(8_192, requirements.estimatedOutputTokens, Math.max(1, Math.floor(route.model.capabilities.maxContextTokens * profile.contextPolicy.outputReserveRatio))),
        parallelToolCalls: route.model.capabilities.parallelTools,
        providerRetryPolicy: {
          maxAttempts: resiliencePolicy.maxProviderAttempts,
          baseDelayMs: resiliencePolicy.providerRetryBaseDelayMs,
        },
        ...(state.transcript.length ? { resumeTranscript: state.transcript } : {}),
        contextPolicy: profile.contextPolicy,
        getPinnedContext: () => JSON.stringify({ approvedPlan: state.plan?.status === "approved" ? state.plan : undefined, permissionSnapshot: spec.grants }),
        beforeToolCall: async (call) => this.authorizeTool(spec, state, call),
        executeTool: async (call, tool, signal) => {
          this.emitEvent(spec.id, state, { type: "tool_started", call });
          const started = Date.now();
          if (!tool.contract.idempotent) state.pendingNonIdempotent.set(call.id, call);
          if ((tool.assessRisk?.(call.input) ?? tool.contract.risk) !== "read" || call.name === "delegate") state.hadSideEffect = true;
          this.saveCheckpoint(spec.id, state, "tool_batch");
          try {
            const result = await tool.execute(call.input, {
              runId: spec.id,
              workspacePath: spec.workspacePath,
              grants: spec.grants,
              signal,
            });
            this.emitEvent(spec.id, state, {
              type: "tool_finished",
              callId: call.id,
              output: result.output,
              durationMs: Date.now() - started,
            });
            if (call.name === "web_search" && result.output && typeof result.output === "object") {
              const search = result.output as { searchId?: unknown; results?: unknown[]; usage?: Record<string, unknown> };
              if (typeof search.searchId === "string") this.emitEvent(spec.id, state, { type: "search_usage", providerId: "parallel", searchId: search.searchId, resultCount: Array.isArray(search.results) ? search.results.length : 0, usage: search.usage ?? {} });
            }
            state.pendingNonIdempotent.delete(call.id);
            this.saveCheckpoint(spec.id, state, "tool_batch");
            return result;
          } catch (error) {
            const output = {
              error: error instanceof Error ? error.message : String(error),
            };
            this.emitEvent(spec.id, state, {
              type: "tool_finished",
              callId: call.id,
              output,
              durationMs: Date.now() - started,
            });
            state.pendingNonIdempotent.delete(call.id);
            this.saveCheckpoint(spec.id, state, "tool_batch");
            throw error;
          }
        },
        shouldStopAfterTurn: (context) => {
          state.turns += 1;
          this.checkBudget(spec, state);
          if (
            state.toolRecoveryLimitReached &&
            context.toolResults.length > 0
          ) {
            recoveryLimitReached = true;
            return true;
          }
          if (
            state.turns >= spec.budget.maxTurns &&
            context.toolResults.length > 0
          ) {
            turnLimitReached = true;
            return true;
          }
          return false;
        },
        onTranscript: async (transcript, reason) => {
          state.transcript = transcript;
          this.saveCheckpoint(spec.id, state, reason);
        },
        onProviderRetry: (retry) => {
          this.emitEvent(spec.id, state, {
            type: "provider_retry",
            ...retry,
          });
        },
        onPiEvent: (event) => {
          if (event.type !== "tool_execution_end") return;
          if (!event.isError) {
            state.consecutiveToolErrors = 0;
            state.toolRecoveryLimitReached = false;
            return;
          }
          state.consecutiveToolErrors += 1;
          const maxAttempts = resiliencePolicy.maxToolSelfCorrections;
          if (maxAttempts === 0 || state.consecutiveToolErrors >= maxAttempts) {
            state.toolRecoveryLimitReached = true;
          }
          if (state.consecutiveToolErrors <= maxAttempts) {
            this.emitEvent(spec.id, state, {
              type: "self_correction_started",
              trigger: "tool_error",
              attempt: state.consecutiveToolErrors,
              maxAttempts,
              summary: `${event.toolName} failed; the structured error was returned to the agent so it can diagnose the cause and change its next action.`,
            });
          }
        },
        onCompaction: async (compaction) => {
          const record = {
            id: newId("compact"),
            runId: spec.id,
            sourceSequenceStart: 0,
            sourceSequenceEnd: Math.max(0, state.sequence - 1),
            summary: compaction.summary,
            summaryHash: createHash("sha256").update(compaction.summary).digest("hex"),
            modelId: route.model.modelId,
            inputTokens: compaction.inputTokens,
            outputTokens: compaction.outputTokens,
            deterministicFallback: compaction.deterministicFallback,
            trust: "untrusted_tool" as const,
            createdAt: nowIso(),
          };
          state.transcript = compaction.after;
          this.deps.database.saveCompaction(record);
          this.emitEvent(spec.id, state, { type: "context_compacted", record });
          this.saveCheckpoint(spec.id, state, "compaction");
        },
        onProviderEvent: (event) => {
          if (event.type === "text_delta") {
            const delta = event.delta ?? "";
            finalText += delta;
            this.emitEvent(spec.id, state, { type: "text_delta", delta });
          }
          if (event.type === "reasoning_summary")
            this.emitEvent(spec.id, state, {
              type: "reasoning_summary",
              summary: event.summary ?? "",
            });
          if (event.type === "tool_call" && event.toolCall)
            this.emitEvent(spec.id, state, {
              type: "tool_call",
              call: event.toolCall,
            });
          if (event.type === "usage" && event.usage) {
            state.spentUsd += event.usage.estimatedUsd;
            state.inputTokens += event.usage.inputTokens;
            state.outputTokens += event.usage.outputTokens;
            this.emitEvent(spec.id, state, {
              type: "usage",
              usage: event.usage,
            });
            this.checkBudget(spec, state);
          }
        },
        afterAgentRun: async (control) => {
          if (turnLimitReached) return;
          const maxRepairs = profile.verificationPolicy.maxRepairAttempts;
          for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
            this.status(spec.id, state, "verifying");
            const verification = await this.verify(spec, profile, state, attempt);
            if (verification.passed) return;
            if (attempt >= maxRepairs || profile.verificationPolicy.items.length === 0) return;
            this.status(spec.id, state, "running");
            this.emitEvent(spec.id, state, { type: "repair_started", attempt: attempt + 1, maxAttempts: maxRepairs });
            this.emitEvent(spec.id, state, {
              type: "self_correction_started",
              trigger: "verification_failure",
              attempt: attempt + 1,
              maxAttempts: maxRepairs,
              summary: "Verification failed; the structured results were returned to the same agent for diagnosis and a revised fix.",
            });
            await control.promptUntrusted(JSON.stringify({ verificationRunId: verification.id, attempt, results: verification.results }));
            state.transcript = control.transcript();
          }
        },
      });
      state.transcript = bridgeResult.transcript;
      if (bridgeResult.errorMessage) throw new Error(bridgeResult.errorMessage);
      if (turnLimitReached || recoveryLimitReached) {
        this.status(spec.id, state, "review");
        this.emitEvent(spec.id, state, {
          type: "result",
          text: `${finalText}\n\n${recoveryLimitReached ? "Run paused for review after repeated tool failures exhausted the self-correction budget." : "Run stopped at the configured turn limit."}`,
          status: "review",
        });
        return;
      }
      const verificationRuns = this.deps.database.listVerificationRuns(spec.id);
      const verified = verificationRuns.at(-1)?.passed ?? !state.hadSideEffect;
      if (finalText.trim()) {
        this.deps.memory.saveSessionSummary(
          spec.sessionId,
          finalText.slice(0, 6_000),
          `run:${spec.id}`,
        );
        this.deps.memory.propose({
          content: `Task: ${spec.request.slice(0, 1_000)}\nOutcome: ${finalText.slice(0, 2_000)}`,
          source: `run:${spec.id}`,
          scope: "project",
          scopeId: spec.workspacePath,
          confidence: verified ? 0.8 : 0.55,
        });
      }
      this.status(spec.id, state, verified ? "completed" : "review");
      this.emitEvent(spec.id, state, {
        type: "result",
        text: finalText,
        status: verified ? "completed" : "review",
      });
    } catch (error) {
      const cancelled = state.controller.signal.aborted;
      const status: RunStatus = cancelled ? "cancelled" : "failed";
      if (transitions[state.status].includes(status))
        this.status(spec.id, state, status);
      this.emitEvent(spec.id, state, {
        type: "error",
        code: cancelled ? "RUN_CANCELLED" : "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: !cancelled,
      });
      this.emitEvent(spec.id, state, {
        type: "result",
        text: cancelled ? "Run cancelled." : "Run failed.",
        status,
      });
    }
  }

  private async authorizeTool(
    spec: RunSpec,
    state: ActiveRun,
    call: ToolCall,
  ): Promise<{ block?: boolean; reason?: string; terminate?: boolean }> {
    state.toolCalls += 1;
    this.checkBudget(spec, state);
    const tool = this.deps.tools.get(call.name);
    if (!tool)
      return { block: true, reason: `Unknown or disabled tool: ${call.name}` };
    const risk = tool.assessRisk?.(call.input) ?? tool.contract.risk;
    if ((risk !== "read" || call.name === "delegate") && !(await this.ensurePlanApproved(spec, state, call, risk))) {
      return { block: true, reason: "The plan was rejected", terminate: true };
    }
    const permission = this.permission.decide(
      call.name,
      call.input,
      risk,
      spec.grants,
      spec.workspacePath,
    );
    if (!permission.allowed) {
      this.status(spec.id, state, "waiting_approval");
      const requestedGrant = {
        toolNames: [call.name],
        pathGlobs: ["**"],
        commandPrefixes:
          typeof call.input.command === "string" ? [call.input.command] : [],
        networkDomains:
          typeof call.input.url === "string"
            ? [new URL(call.input.url).hostname]
            : [],
        maxRisk: risk,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      const { approval, decision } = this.approvals.request(
        {
          runId: spec.id,
          toolName: call.name,
          normalizedInput: call.input,
          risk,
          reason: permission.reason,
          requestedGrant,
        },
        state.controller.signal,
      );
      this.emitEvent(spec.id, state, {
        type: "approval_required",
        approvalId: approval.id,
        summary: summarizeToolRequest(call, risk),
        risk,
      });
      if (!(await decision)) {
        this.status(spec.id, state, "running");
        return {
          block: true,
          reason: "Tool execution denied or approval expired",
        };
      }
      spec.grants = [...spec.grants, requestedGrant];
      this.deps.database.saveRun(spec, state.status);
      this.saveCheckpoint(spec.id, state, "manual");
      this.status(spec.id, state, "running");
    }
    return {};
  }

  private async ensurePlanApproved(spec: RunSpec, state: ActiveRun, call: ToolCall, risk: "read" | "write" | "high" | "destructive"): Promise<boolean> {
    let plan = state.plan ?? this.deps.database.getPlanForRun(spec.id);
    if (plan?.status === "approved" && planCovers(plan, call, risk)) return true;
    const now = nowIso();
    if (!plan) {
      plan = {
        id: newId("plan"),
        runId: spec.id,
        goal: spec.request,
        version: 1,
        status: "awaiting_approval",
        steps: [planStepFor(call, risk, 1)],
        scope: scopeFor(call, risk),
        createdAt: now,
        updatedAt: now,
      };
      this.emitEvent(spec.id, state, { type: "plan_created", plan });
    } else {
      plan = {
        ...plan,
        version: plan.version + 1,
        status: "awaiting_approval",
        steps: [...plan.steps, planStepFor(call, risk, plan.steps.length + 1)],
        scope: mergeScope(plan.scope, scopeFor(call, risk)),
        approvalId: undefined,
        approvedBy: undefined,
        approvedAt: undefined,
        updatedAt: now,
      };
      this.emitEvent(spec.id, state, { type: "plan_updated", plan });
    }
    for (;;) {
      this.deps.database.savePlan(plan);
      state.plan = plan;
      this.status(spec.id, state, "waiting_approval");
      this.emitEvent(spec.id, state, { type: "plan_approval_required", planId: plan.id, version: plan.version, summary: `${plan.goal}\n${plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join("\n")}` });
      const decision = await new Promise<{ approved: boolean; actor: string; feedback?: string }>((resolveDecision) => {
        this.planDecisions.set(plan!.id, resolveDecision);
        const abort = () => resolveDecision({ approved: false, actor: "system", feedback: "Run cancelled" });
        state.controller.signal.addEventListener("abort", abort, { once: true });
      });
      this.planDecisions.delete(plan.id);
      if (state.controller.signal.aborted) return false;
      if (decision.approved) {
        plan = { ...plan, status: "approved", approvedBy: decision.actor, approvedAt: nowIso(), updatedAt: nowIso() };
        this.deps.database.savePlan(plan);
        state.plan = plan;
        this.emitEvent(spec.id, state, { type: "plan_updated", plan });
        this.saveCheckpoint(spec.id, state, "plan_decision");
        this.status(spec.id, state, "running");
        return true;
      }
      if (!decision.feedback) {
        plan = { ...plan, status: "rejected", updatedAt: nowIso() };
        this.deps.database.savePlan(plan);
        state.plan = plan;
        this.emitEvent(spec.id, state, { type: "plan_updated", plan });
        this.saveCheckpoint(spec.id, state, "plan_decision");
        this.status(spec.id, state, "running");
        return false;
      }
      plan = { ...plan, version: plan.version + 1, status: "awaiting_approval", goal: `${spec.request}\nRevision feedback: ${decision.feedback}`, updatedAt: nowIso() };
      this.emitEvent(spec.id, state, { type: "plan_updated", plan });
    }
  }

  private async verify(
    spec: RunSpec,
    profile: Profile,
    state: ActiveRun,
    attempt: number,
  ): Promise<VerificationRun> {
    const startedAt = nowIso();
    const verificationRunId = newId("verify");
    this.emitEvent(spec.id, state, { type: "verification_started", verificationRunId, attempt });
    if (profile.verificationPolicy.items.length === 0) {
      const verification: VerificationRun = { id: verificationRunId, runId: spec.id, attempt, results: [], passed: !state.hadSideEffect, startedAt, finishedAt: nowIso() };
      this.deps.database.saveVerificationRun(verification);
      this.emitEvent(spec.id, state, { type: "verification_finished", verification });
      this.saveCheckpoint(spec.id, state, "verification");
      return verification;
    }
    const terminal = this.deps.tools.get("terminal");
    const results: VerificationRun["results"] = [];
    for (const item of profile.verificationPolicy.items) {
      const workspacePath = resolve(spec.workspacePath, item.cwd);
      const outside = relative(resolve(spec.workspacePath), workspacePath).startsWith("..") || relative(resolve(spec.workspacePath), workspacePath).startsWith("/");
      const started = Date.now();
      if (!terminal || outside) {
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: outside ? "Verification cwd escapes the workspace." : "terminal tool is unavailable", durationMs: Date.now() - started, timedOut: false });
        continue;
      }
      const decision = this.permission.decide(
        "terminal",
        { command: item.command },
        "high",
        spec.grants,
        spec.workspacePath,
      );
      if (!decision.allowed) {
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: `Verification permission denied: ${decision.reason}`, durationMs: Date.now() - started, timedOut: false });
        continue;
      }
      try {
        const result = await terminal.execute(
          { command: item.command, timeoutMs: item.timeoutMs },
          { runId: spec.id, workspacePath, grants: spec.grants, signal: state.controller.signal },
        );
        const output = result.output as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
        const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode, passed: exitCode !== null && item.expectedExitCodes.includes(exitCode), required: item.required, output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`.trim().slice(0, 64_000), durationMs: Date.now() - started, timedOut: output.timedOut === true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: message, durationMs: Date.now() - started, timedOut: /timed? out/i.test(message) });
      }
    }
    const verification: VerificationRun = { id: verificationRunId, runId: spec.id, attempt, results, passed: results.every((result) => !result.required || result.passed), startedAt, finishedAt: nowIso() };
    this.deps.database.saveVerificationRun(verification);
    this.emitEvent(spec.id, state, { type: "verification_finished", verification });
    this.saveCheckpoint(spec.id, state, "verification");
    return verification;
  }

  private saveCheckpoint(runId: string, state: ActiveRun, reason: RunCheckpoint["reason"]): RunCheckpoint {
    const checkpoint: RunCheckpoint = {
      id: newId("checkpoint"),
      runId,
      sequence: state.sequence,
      reason,
      status: state.status,
      transcript: state.transcript,
      ...(state.plan ? { planVersion: state.plan.version } : {}),
      usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens, estimatedUsd: state.spentUsd },
      turns: state.turns,
      toolCalls: state.toolCalls,
      pendingNonIdempotentToolCalls: [...state.pendingNonIdempotent.values()],
      createdAt: nowIso(),
    };
    this.deps.database.saveCheckpoint(checkpoint);
    this.emitEvent(runId, state, { type: "checkpoint_saved", checkpointId: checkpoint.id, reason });
    return checkpoint;
  }

  private checkBudget(spec: RunSpec, state: ActiveRun): void {
    if (state.toolCalls > spec.budget.maxToolCalls)
      throw new Error("Tool-call budget exceeded");
    if (state.spentUsd > spec.budget.maxUsd)
      throw new Error("Cost budget exceeded");
    if (Date.now() - state.startedAt > spec.budget.maxDurationMs)
      throw new Error("Run duration budget exceeded");
    if (state.controller.signal.aborted)
      throw state.controller.signal.reason ?? new Error("Run cancelled");
  }

  private status(runId: string, state: ActiveRun, status: RunStatus): void {
    if (!transitions[state.status].includes(status))
      throw new Error(`Invalid run transition ${state.status} -> ${status}`);
    state.status = status;
    this.deps.database.updateRunStatus(runId, status);
    this.emitEvent(runId, state, { type: "status", status });
  }

  private emitEvent(
    runId: string,
    state: ActiveRun,
    event: AgentEventInput,
  ): AgentEvent {
    const complete = {
      ...event,
      id: newId("event"),
      runId,
      at: nowIso(),
      sequence: state.sequence++,
    } as AgentEvent;
    this.deps.database.appendEvent(complete);
    const profileId = this.deps.database.getRun(runId)?.spec.profileId ?? "unknown";
    const span = this.tracer.startSpan(`harness.${complete.type}`, { attributes: { "harness.run_id": runId, "harness.profile_id": profileId, "harness.event_type": complete.type, "harness.sequence": complete.sequence } });
    if (complete.type === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: complete.code });
    else span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.deps.database.appendTrace({ id: newId("trace"), runId, type: complete.type, at: complete.at, attributes: traceAttributes(complete) });
    this.emit("event", complete);
    return complete;
  }
}

function traceAttributes(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "route": return { providerId: event.providerId, modelId: event.modelId, estimatedUsd: event.estimatedUsd };
    case "tool_call": return { toolName: event.call.name };
    case "tool_started": return { toolName: event.call.name };
    case "tool_finished": return { callId: event.callId, durationMs: event.durationMs };
    case "usage": return event.usage;
    case "verification_finished": return { verificationRunId: event.verification.id, passed: event.verification.passed, attempt: event.verification.attempt };
    case "provider_retry": return { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, category: event.category, recovery: event.recovery };
    case "self_correction_started": return { trigger: event.trigger, attempt: event.attempt, maxAttempts: event.maxAttempts };
    case "context_compacted": return { compactionId: event.record.id, inputTokens: event.record.inputTokens, outputTokens: event.record.outputTokens, deterministicFallback: event.record.deterministicFallback };
    case "plugin_event": return { pluginId: event.pluginId, action: event.action };
    case "search_usage": return { providerId: event.providerId, searchId: event.searchId, resultCount: event.resultCount };
    case "recovery_event": return { checkpointId: event.checkpointId ?? "", action: event.action };
    case "error": return { code: event.code, retryable: event.retryable };
    default: return {};
  }
}
