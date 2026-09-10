import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { LightweightWorkflow } from "./lightweight-workflow.js";
import { snapshotWorkspace, compareWorkspace } from "./workspace-impact.js";
import { probeCommandScope, probeDirectory, probeInput, todoTool, validateProbeInput, validateVerificationInput, verificationInput } from "./runtime-tools.js";
import { lightweightTools, runProcess } from "@harness/tools";
import type { ToolDefinition } from "@harness/tools";
import { AGENT_VERSION, promptCacheKey, repositoryBaseSnapshot } from "./prompt-cache.js";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
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
  RunStopInfo,
  ToolCall,
  VerificationRun,
} from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";
import { ModelRouter } from "@harness/providers";
import type { MemoryService, SkillService } from "@harness/extensions";
import type { HarnessDatabase } from "@harness/persistence";
import type { ToolRegistry } from "@harness/tools";
import { confinedPath } from "@harness/tools";
import { ApprovalBroker } from "./approvals.js";
import { buildInitialMessages } from "./context.js";
import { runWithPiAgent } from "./pi-agent-bridge.js";
import { buildSessionContext } from "./session-context.js";
import { BudgetExceededError, buildRunStop } from "./run-stop.js";
import { RunProgress } from "./run-progress.js";
import { CodingWorkflow, compactObservation } from "./coding-workflow.js";
import { reviewChanges } from "./independent-review.js";
import { PermissionEngine, summarizeToolRequest } from "./security.js";
import type { ProjectTrustService } from "./project-trust.js";

const transitions: Record<RunStatus, RunStatus[]> = {
  queued: ["planning", "cancelled", "failed"],
  planning: ["running", "review", "failed", "cancelled"],
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
  workflow?: CodingWorkflow;
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
  repairAttemptsUsed: number;
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
    const session = this.deps.database.getSessionDetail(spec.sessionId)?.session;
    if (session && !session.deletedAt) this.deps.database.touchSession(spec.sessionId, {
      profileId: spec.profileId,
      title: session.title === "新会话" && spec.request.trim()
        ? spec.request.trim().slice(0, 300)
        : session.title,
      updatedAt: spec.createdAt,
    });
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
      repairAttemptsUsed: 0,
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
      repairAttemptsUsed: checkpoint.repairAttemptsUsed ?? this.deps.database.listEvents(runId).filter(event => event.type === "repair_started").length,
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
      const repositorySnapshot = await repositoryBaseSnapshot(spec.workspacePath);
      const messages = buildInitialMessages({
        run: spec,
        profile,
        memories,
        trustedSkills,
        ...(trustedProjectInstructions ? { trustedProjectInstructions } : {}),
      });
      const conversationHistory = recovery
        ? []
        : buildSessionContext(
            this.deps.database.getSessionDetail(spec.sessionId),
            spec.id,
            48_000,
          );
      const modern = spec.workflowVersion !== 1 && (!recovery?.workflow || recovery.workflow.schemaVersion >= 3);
      const Workflow = modern ? LightweightWorkflow : CodingWorkflow;
      const workflow = new Workflow(spec.request, (snapshot, detail) => {
        this.emitEvent(spec.id, state, { type: "workflow_updated", workflow: snapshot, detail });
      }, recovery?.workflow, profile.verificationPolicy, spec.taskMode ?? "auto");
      state.workflow = workflow;
      if (recovery?.pendingNonIdempotentToolCalls.length) workflow.fail("Execution state is unknown after restart. Inspect current repository state and diagnose before any new mutation or verification command.");
      const workflowTool = workflow.tool();
      const runtimeTools = new Map<string, ToolDefinition>();
      if (workflow instanceof LightweightWorkflow) {
        for (const tool of lightweightTools(this.deps.tools, profile.toolNames)) runtimeTools.set(tool.contract.name, tool);
        runtimeTools.set("todo", todoTool(workflow));
        runtimeTools.set("read_evidence", {
          contract: { name: "read_evidence", description: "Read saved tool evidence by its original call ID; use offset and limit to page long output without rerunning commands.", inputSchema: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 } }, required: ["id"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
          execute: async input => {
            const value = z.object({ id: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(6000) }).parse(input);
            // Indexed lookup: the previous scan decrypted every event of the run on each call.
            const event = this.deps.database.getToolEvidence(spec.id, value.id);
            if (!event || event.type !== "tool_finished") return { isError: true, output: { code: "evidence_not_found", id: value.id } };
            const text = JSON.stringify(event.output);
            return { output: { id: value.id, content: text.slice(value.offset, value.offset + value.limit), ...(text.length > value.offset + value.limit ? { nextOffset: value.offset + value.limit } : {}), isError: event.isError } };
          },
        });
        if (profile.toolNames.includes("terminal")) runtimeTools.set("run_verification", {
          contract: { name: "run_verification", description: "Run a verification command with cwd, timeoutMs and optional stdin. Runtime records real exit status and code fingerprint. Interpreter commands reading stdin require the script. Checks never become passed merely by updating todo.", inputSchema: z.toJSONSchema(verificationInput, { io: "input" }), risk: "high", idempotent: false, timeoutMs: 3600000 },
          handlesInputValidation: true,
          selfAuthorized: true,
          execute: async input => {
            let value;
            try { value = validateVerificationInput(input); } catch (error) { state.toolCalls++; return { isError: true, output: { code: "verification_config_missing", error: String(error), recoverable: true } }; }
            const terminal = this.deps.tools.get("terminal")!;
            const blocked = workflow.before({ id: "check", name: "terminal", input: value }, terminal);
            if (blocked) { state.toolCalls++; return { isError: true, output: { code: "analysis_mode_read_only", error: blocked } }; }
            workflow.state.verification = [...workflow.state.verification.filter(item => item.stage !== value.stage), value];
            const run = await this.verify(spec, profile, state, state.repairAttemptsUsed, value.stage);
            return { output: { evidenceId: run.id, passed: run.passed, revision: run.revision, results: run.results }, isError: !run.passed };
          },
        });
        if (profile.toolNames.includes("terminal")) {
          // A probe owns its authorization, so it needs its own definition for the permission check.
          const probeTool: ToolDefinition = {
            contract: { name: "probe", description: "Run one bounded temporary experiment or inspection: a count, a one-off interpreter script supplied through stdin, or an existing test subset. Probes run inside an isolated probe directory outside the repository, so scratch files belong there. Repository edits still require change mode, and every probe is compared against the repository before and after. The first probe of a given program is approved once per run for that program.", inputSchema: z.toJSONSchema(probeInput, { io: "input" }), risk: "high", idempotent: false, timeoutMs: 300_000 },
            assessRisk: input => this.deps.tools.get("terminal")?.assessRisk?.(input) ?? "high",
            handlesInputValidation: true,
            selfAuthorized: true,
            execute: async input => {
              let value;
              try { value = validateProbeInput(input); } catch (error) { state.toolCalls++; return { isError: true, output: { code: "probe_config_missing", error: String(error), recoverable: true } }; }
              const call: ToolCall = { id: newId("probe"), name: "probe", input: { command: value.command } };
              // The approval is scoped to the program, not to the exact arguments: an approved `python`
              // probe covers further `python` probes in this run, while another program asks again.
              const authorization = await this.authorizeTool(spec, state, call, { approvalTtlMs: Math.max(1_000, spec.budget.maxDurationMs - (Date.now() - state.startedAt)), commandPrefixes: [probeCommandScope(value.command)] }, probeTool);
              if (authorization.block) return { isError: true, output: { code: "probe_denied", error: authorization.reason } };
              const directory = probeDirectory(spec.id);
              await mkdir(directory, { recursive: true });
              const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
              const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", value.command] : ["-lc", value.command];
              const result = await runProcess(shell, args, { cwd: directory, signal: state.controller.signal, timeoutMs: Math.max(1, Math.min(value.timeoutMs, spec.budget.maxDurationMs - (Date.now() - state.startedAt))), ...(value.stdin !== undefined ? { stdin: value.stdin } : {}) });
              const failed = result.exitCode !== 0 || result.timedOut;
              return { output: { evidenceId: call.id, cwd: directory, result: compactObservation(result, 6000), isError: failed }, isError: failed };
            },
          };
          runtimeTools.set("probe", probeTool);
        }
      }
      const contracts = modern ? [...runtimeTools.values()].map(tool => tool.contract) : this.deps.tools.contracts(profile.toolNames);
      if (!modern && contracts.length) contracts.push(workflowTool.contract);
      workflow.move(workflow.state.phase, recovery ? "恢复工作流；代码验证与评审需要重新执行" : "接收用户任务，准备理解目标");
      const requirements = {
        needsVision: spec.attachments.length > 0,
        needsTools: contracts.length > 0,
        needsStructuredOutput: false,
        estimatedInputTokens: Math.max(
          512,
          Math.ceil(JSON.stringify([...messages, ...conversationHistory]).length / 4),
        ),
        // A 4096 estimate used to be the binding constraint here, so the 8192 ceiling below was dead
        // code and a long single answer (an analysis report, a probe script) hit the cap and came
        // back as a truncated response. Ask for the ceiling; the reserve ratio still protects models
        // with a small context window.
        estimatedOutputTokens: 8_192,
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
      let stopReason: string | undefined;
      let stopCode: RunStopInfo["code"] = "review_incomplete";
      let summaryError: string | undefined;
      const stop = (code: RunStopInfo["code"], message: string) => { stopCode = code; stopReason = message; };
      let summarizing = false;
      let verificationRequested = false;
      const progress = new RunProgress();
      if (state.turns >= spec.budget.maxTurns || (state.toolCalls > 0 && state.toolCalls >= spec.budget.maxToolCalls)) {
        this.status(spec.id, state, "review");
        const code = state.turns >= spec.budget.maxTurns ? "model_turn_limit" : "tool_call_limit";
        this.emitEvent(spec.id, state, { type: "result", status: "review", text: "本轮预算已用完，历史结果已保留。", stop: buildRunStop(code, code === "model_turn_limit" ? "模型轮次已用完" : "工具调用额度已用完", spec, state, workflow.snapshot()) });
        return;
      }
      const resiliencePolicy = profile.resiliencePolicy ?? {
        maxProviderAttempts: 3,
        providerRetryBaseDelayMs: 500,
        maxToolSelfCorrections: null,
      };
      const bridgeResult = await runWithPiAgent({
        runId: spec.id,
        sessionId: spec.sessionId,
        provider: route.provider,
        model: route.model,
        initialMessages: messages,
        promptCacheKey: promptCacheKey(AGENT_VERSION, repositorySnapshot.repoId),
        responsesContinuation: profile.responsesContinuation !== false,
        ...(conversationHistory.length ? { conversationHistory } : {}),
        contracts,
        resolveTool: (name) => modern ? runtimeTools.get(name) : name === "update_workflow" ? workflowTool : this.deps.tools.get(name),
        externalSignal: state.controller.signal,
        maxOutputTokens: Math.min(8_192, requirements.estimatedOutputTokens, Math.max(1, Math.floor(route.model.capabilities.maxContextTokens * profile.contextPolicy.outputReserveRatio))),
        parallelToolCalls: modern ? false : route.model.capabilities.parallelTools,
        providerRetryPolicy: {
          maxAttempts: resiliencePolicy.maxProviderAttempts,
          baseDelayMs: resiliencePolicy.providerRetryBaseDelayMs,
        },
        ...(state.transcript.length ? { resumeTranscript: state.transcript } : {}),
        contextPolicy: profile.contextPolicy,
        getPinnedContext: () => JSON.stringify({
          projectBaseSnapshot: repositorySnapshot,
          approvedPlan: state.plan?.status === "approved" ? state.plan : undefined,
          permissionSnapshot: spec.grants,
          workingMemory: { trust: "untrusted_tool", ...(workflow instanceof LightweightWorkflow ? workflow.projection() : workflow.snapshot()) },
          verificationPolicy: profile.verificationPolicy,
          missingVerificationStages: workflow.missingVerificationStages(),
          remainingToolCalls: Math.max(0, spec.budget.maxToolCalls - state.toolCalls),
          remainingTurns: Math.max(0, spec.budget.maxTurns - state.turns),
          repairAttemptsUsed: state.repairAttemptsUsed,
          remainingRepairAttempts: null,
          ...(modern ? {} : { recentObservations: { trust: "untrusted_tool", items: progress.snapshot() } }),
          guidance: spec.budget.maxToolCalls - state.toolCalls <= Math.max(4, Math.ceil(spec.budget.maxToolCalls * 0.2))
            ? "Budget is nearly exhausted. Synthesize concrete findings now. Do not restart repository exploration; clearly state unresolved scope."
            : "Reuse observations already collected; avoid repeated reads without new evidence.",
        }),
        beforeCompactionRequest: () => {
          this.checkBudget(spec, state);
          if (state.turns >= spec.budget.maxTurns - 1) return false;
          state.turns += 1;
          return true;
        },
        beforeModelRequest: () => {
          this.checkBudget(spec, state);
          if (state.turns > spec.budget.maxTurns) throw new BudgetExceededError("model_turn_limit", "模型轮次额度已用完");
        },
        beforeToolCall: async (call) => {
          if (summarizing || stopReason) return { block: true, terminate: true, reason: stopReason ?? "Only a final summary is allowed." };
          if (state.toolCalls >= spec.budget.maxToolCalls) {
            stop("tool_call_limit", "工具调用额度已用完，保留现有结果供复核。");
            return { block: true, terminate: true, reason: stopReason! };
          }
          if (!modern && call.name === "update_workflow") { state.toolCalls += 1; return {}; }
          const runtimeTool = modern ? runtimeTools.get(call.name) : undefined;
          const registered = this.deps.tools.get(modern && call.name === "patch" ? "apply_patch" : call.name);
          const tool = runtimeTool ?? registered;
          const blocked = tool && workflow.before(call, tool);
          if (blocked) { state.toolCalls += 1; return { block: true, reason: blocked }; }
          if (runtimeTool && !registered) {
            // Runtime-owned tools are absent from the durable registry, so the permission pipeline
            // cannot authorize them. Only declared read risk, or a tool that runs its own
            // authorization and budget accounting, may skip it — never a hardcoded name list.
            if (runtimeTool.selfAuthorized === true) return {};
            if ((runtimeTool.assessRisk?.(call.input) ?? runtimeTool.contract.risk) !== "read") {
              state.toolCalls += 1;
              return { block: true, reason: `Runtime tool ${call.name} is not read-only and does not manage its own authorization.` };
            }
            state.toolCalls += 1;
            return {};
          }
          return this.authorizeTool(spec, state, call.name === "patch" ? { ...call, name: "apply_patch" } : call);
        },
        executeTool: async (call, tool, signal) => {
          this.emitEvent(spec.id, state, { type: "tool_started", call });
          const started = Date.now();
          const measureEffect = modern && !["todo", "read_evidence", "run_verification"].includes(call.name) && ((tool.assessRisk?.(call.input) ?? tool.contract.risk) !== "read" || call.name === "git_diff");
          const before = measureEffect ? await snapshotWorkspace(spec.workspacePath) : undefined;
          if (!tool.contract.idempotent) state.pendingNonIdempotent.set(call.id, call);
          if ((tool.assessRisk?.(call.input) ?? tool.contract.risk) !== "read" || call.name === "delegate") {
            state.hadSideEffect = true;
            if (!modern) progress.invalidate();
          }
          workflow.starting(call, tool);
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
              isError: result.isError === true,
              durationMs: Date.now() - started,
            });
            if (call.name === "web_search" && result.output && typeof result.output === "object") {
              const search = result.output as { searchId?: unknown; results?: unknown[]; usage?: Record<string, unknown> };
              if (typeof search.searchId === "string") this.emitEvent(spec.id, state, { type: "search_usage", providerId: "parallel", searchId: search.searchId, resultCount: Array.isArray(search.results) ? search.results.length : 0, usage: search.usage ?? {} });
            }
            if (before && workflow instanceof LightweightWorkflow) {
              const effect = compareWorkspace(before, await snapshotWorkspace(spec.workspacePath));
              // A probe that left the repository untouched is recorded as a probe, never as a read: the
              // run must be able to tell an isolated experiment from an inspection. A probe that did
              // change tracked content stays a repository write.
              workflow.applyEffect(modern && call.name === "probe" && effect.kind === "read" ? { kind: "probe", changedFiles: [] } : effect);
              if (effect.kind === "repository_write" || effect.kind === "unknown") progress.invalidate();
            }
            workflow.observe(call, result);
            if (call.name === "update_workflow" && call.input.action === "request_verification" && !result.isError) verificationRequested = true;
            const repetition = progress.record(call, tool, result);
            if (repetition && !stopReason && !modern) stop("repeated_observation", repetition);
            state.pendingNonIdempotent.delete(call.id);
            this.saveCheckpoint(spec.id, state, "tool_batch");
            return modern ? { ...result, output: { evidenceId: call.id, result: compactObservation(result.output, 6000), isError: result.isError === true } } : call.name === "terminal" ? { ...result, output: { observation: compactObservation(result.output), isError: result.isError === true } } : result;
          } catch (error) {
            const output = {
              error: error instanceof Error ? error.message : String(error),
            };
            if (before && workflow instanceof LightweightWorkflow) {
              const effect = compareWorkspace(before, await snapshotWorkspace(spec.workspacePath));
              workflow.applyEffect(modern && call.name === "probe" && effect.kind === "read" ? { kind: "probe", changedFiles: [] } : effect);
            }
            workflow.observe(call, { output, isError: true });
            const repetition = progress.record(call, tool, { output, isError: true });
            if (repetition && !stopReason && !modern) stop("repeated_observation", repetition);
            this.emitEvent(spec.id, state, {
              type: "tool_finished",
              callId: call.id,
              output,
              isError: true,
              durationMs: Date.now() - started,
            });
            state.pendingNonIdempotent.delete(call.id);
            this.saveCheckpoint(spec.id, state, "tool_batch");
            // A thrown failure carries no result reference on the wire: pi turns the exception into a
            // bare error message. Hand the model the same evidence envelope a structured failure
            // returns so a failed call is still retrievable by read_evidence. The legacy path keeps
            // throwing, because its recovery and tests depend on the exception.
            if (modern) return { output: { evidenceId: call.id, result: compactObservation(output, 6000), isError: true }, isError: true };
            throw error;
          }
        },
        shouldStopAfterTurn: (context) => {
          this.checkBudget(spec, state);
          if (!context.message.content.some((part) => part.type === "toolCall")) {
            finalText = context.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
          }
          if (summarizing) return true;
          if (context.toolResults.length > 0) {
            if (!stopReason && state.toolCalls >= spec.budget.maxToolCalls) stop("tool_call_limit", "工具调用额度已用完，保留现有结果供复核。");
            // Keep the last available model turn for a tool-free evidence summary.
            if (!stopReason && state.turns >= spec.budget.maxTurns - 1) stop("model_turn_limit", "模型操作轮次已用完，保留最后一轮整理结果。");
          }
          const requested = verificationRequested;
          verificationRequested = false;
          return !!stopReason || requested;
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
          if (event.type === "turn_start") {
            state.turns += 1;
            this.emitEvent(spec.id, state, { type: "assistant_turn_started" });
          }
          if (event.type !== "tool_execution_end") return;
          if (!event.isError) {
            state.consecutiveToolErrors = 0;
            return;
          }
          state.consecutiveToolErrors += 1;
          this.emitEvent(spec.id, state, {
            type: "self_correction_started", trigger: "tool_error",
            attempt: state.consecutiveToolErrors, maxAttempts: null,
            summary: `${event.toolName} failed; inspect the structured error and revise the action. Recovery is limited by the remaining run budget, not a retry count.`,
          });
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
          const finishStoppedRun = async () => {
            if (!stopReason || summarizing || state.turns >= spec.budget.maxTurns || state.controller.signal.aborted) return;
            if (state.spentUsd >= spec.budget.maxUsd || Date.now() - state.startedAt >= spec.budget.maxDurationMs) return;
            summarizing = true;
            try {
              await control.promptSummary(`Runtime stopping condition: ${stopReason}\nNo tools are available. Answer the original user request using only evidence already collected. State concrete findings and file paths, then unresolved questions and uninspected scope. Do not say you will keep exploring or claim the task is complete. Use the user's language.`);
            } catch (error) { summaryError = error instanceof Error ? error.message : String(error); }
          };
          if (stopReason) { await finishStoppedRun(); return; }
          try {
            for (;;) {
              this.checkBudget(spec, state);
              if (workflow instanceof LightweightWorkflow) workflow.acceptFinalReport(finalText);
              if (workflow.baseCanFinish() && workflow.requiresIndependentReview && !workflow.canFinish()) {
                if (state.turns >= spec.budget.maxTurns) { stop("model_turn_limit", "独立评审尚未完成，模型轮次额度已用完。"); return; }
                const diffObservation = workflow.state.observations.findLast(item => item.tool === "git_diff" && item.epoch === workflow.state.epoch && item.revision === workflow.state.revision && !item.failed && item.complete);
                const reviewEvents = this.deps.database.listEvents(spec.id);
                const diffEvent = reviewEvents.findLast(event => event.type === "tool_finished" && event.callId === diffObservation?.id);
                if (!diffEvent || diffEvent.type !== "tool_finished") { stopReason = "独立评审缺少完整 diff 记录。"; return; }
                const checkIds = [workflow.state.localCheck.runId, workflow.state.broaderCheck.runId].filter(Boolean);
                const verificationRuns = this.deps.database.listVerificationRuns(spec.id).filter(run => checkIds.includes(run.id) && run.epoch === workflow.state.epoch && run.revision === workflow.state.revision);
                const evidenceIds = [...new Set([...workflow.state.requirementReceipts.flatMap(receipt => [...receipt.observationIds, receipt.diffObservationId]), ...workflow.state.reviewEvidenceIds])];
                const observations = evidenceIds.map(id => {
                  const observed = workflow.state.observations.find(item => item.id === id && item.epoch === workflow.state.epoch && item.revision === workflow.state.revision && !item.failed && item.complete);
                  if (!observed) return undefined;
                  const event = reviewEvents.findLast(item => item.type === "tool_finished" && item.callId === id && !item.isError);
                  const verification = verificationRuns.find(item => item.id === id);
                  if (!event && !verification) return undefined;
                  return { ...observed, output: event?.type === "tool_finished" ? event.output : verification };
                });
                if (verificationRuns.length !== checkIds.length || observations.some(item => !item)) { stopReason = "独立评审引用的原始证据缺失，需要重新收集。"; return; }
                workflow.move("final_review", "触发独立只读评审，检查需求、回归与边界条件");
                state.turns += 1;
                try {
                  const result = await reviewChanges({
                    provider: route.provider, model: route.model, runId: spec.id, state: workflow.snapshot(), diff: diffEvent.output, observations, verificationRuns,
                    signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(60000, spec.budget.maxDurationMs - (Date.now() - state.startedAt))))]),
                    remainingUsd: Math.max(0, spec.budget.maxUsd - state.spentUsd),
                    onUsage: usage => { state.spentUsd += usage.estimatedUsd; state.inputTokens += usage.inputTokens; state.outputTokens += usage.outputTokens; this.emitEvent(spec.id, state, { type: "usage", usage }); this.checkBudget(spec, state); },
                  });
                  this.checkBudget(spec, state);
                  workflow.recordIndependentReview(result.passed, result.summary);
                } catch (error) { stop(error instanceof BudgetExceededError ? error.code : "review_incomplete", "独立评审未完成：" + (error instanceof Error ? error.message : String(error))); return; }
                finally { this.saveCheckpoint(spec.id, state, "verification"); }
              }
              if (workflow.canFinish()) return;
              if (modern) {
                if (!workflow.needsChange && workflow.checksCurrent() && finalText.trim()) return;
                if (state.turns >= spec.budget.maxTurns || state.toolCalls >= spec.budget.maxToolCalls) { stop("review_incomplete", "修改待验证或缺少当前证据"); return; }
                await control.promptUntrusted(JSON.stringify({ workingMemory: (workflow as LightweightWorkflow).projection(), nextAction: workflow.checksCurrent() ? "Read git_diff, check the original requirements against the actual diff and test evidence, then report findings and limitations." : workflow.state.effect === "unknown" ? "The last execution effect is unconfirmed. Run a read-only repository recheck (git status --short or git diff --no-ext-diff) and resolve it before reporting; never claim the workspace is unchanged." : "Use run_verification with a relevant real test command (including stdin when required). Inspect and fix failing checks before reporting completion. Unconfirmed execution effects require repository inspection." }));
                state.transcript = control.transcript();
                if (stopReason) { await finishStoppedRun(); return; }
                continue;
              }
              const missingVerificationStages = workflow.missingVerificationStages();
              if (missingVerificationStages.length && !workflow.state.diagnosisRequired) {
                if (state.toolCalls >= spec.budget.maxToolCalls) { stop("tool_call_limit", "工具调用额度已用完，仍缺少验证配置。"); return; }
                if (state.turns >= spec.budget.maxTurns) { stop("model_turn_limit", "模型轮次额度已用完，仍缺少验证配置。"); return; }
                if (state.status !== "running") this.status(spec.id, state, "running");
                await control.promptUntrusted(JSON.stringify({
                  code: "verification_config_missing", recoverable: true, missingVerificationStages,
                  nextAction: "Verification configuration is missing, not a code failure. Keep any required scripts available. Call update_workflow action=request_verification with verification items (stage, command, cwd, timeoutMs) matching the repository. Runtime will authorize and run them, then require diff and requirement review. Do not report completion before checks run.",
                  workflow: workflow.snapshot(),
                }));
                state.transcript = control.transcript();
                if (stopReason) { await finishStoppedRun(); return; }
                continue;
              }
              let passed = workflow.checksCurrent();
              if (!passed && !workflow.state.diagnosisRequired) {
                this.status(spec.id, state, "verifying");
                workflow.move("local_verification", "先运行局部验证；失败时不运行扩大验证");
                const local = await this.verify(spec, profile, state, state.repairAttemptsUsed, "local");
                workflow.move("inspect_result", local.outcome === "skipped" ? "只读任务跳过代码验证" : local.passed ? "局部验证通过" : "局部验证失败");
                passed = local.passed || (!workflow.needsChange && local.outcome === "skipped");
                if (passed) {
                  workflow.move("broader_verification", this.verificationItems(profile, state).some(item => item.stage === "broader") ? "局部验证通过，运行扩大验证" : "未配置扩大验证项；保留局部验证证据，进入需求核对");
                  await this.verify(spec, profile, state, state.repairAttemptsUsed, "broader");
                  passed = workflow.checksCurrent();
                }
                this.saveCheckpoint(spec.id, state, "verification");
              }
              if (!workflow.needsChange && passed) {
                workflow.move("requirements_check", "只读任务：记录结论，不要求代码修改验证");
                workflow.move("final_review", "运行时检查结束状态与验证结果");
                return;
              }
              if (workflow.canFinish()) return;
              if (state.toolCalls >= spec.budget.maxToolCalls && state.toolCalls > 0) {
                stop("tool_call_limit", "工具调用额度已用完，验证或评审尚未完成。"); return;
              }
              if (state.turns >= spec.budget.maxTurns) {
                stop("model_turn_limit", "模型轮次额度已用完，验证或评审尚未完成。"); return;
              }
              if (state.status !== "running") this.status(spec.id, state, "running");
              if (!passed || workflow.state.diagnosisRequired) {
                state.repairAttemptsUsed += 1;
                this.emitEvent(spec.id, state, { type: "repair_started", attempt: state.repairAttemptsUsed, maxAttempts: null });
                this.saveCheckpoint(spec.id, state, "verification");
                this.emitEvent(spec.id, state, { type: "self_correction_started", trigger: "verification_failure", attempt: state.repairAttemptsUsed, maxAttempts: null, summary: workflow.strategy() });
              } else workflow.move("requirements_check", "验证通过；读取当前 git_diff，核对全部验收条件并执行最终评审");
              await control.promptUntrusted(JSON.stringify({
                workflow: workflow.snapshot(),
                nextAction: passed && !workflow.state.diagnosisRequired
                  ? "Use git_diff for current changes. Call update_workflow requirements with passed and one structured evidence receipt per requirementId: summary, observationIds, verificationIds (successful local/broader run IDs) and diffObservationId. Then call review with passed, evidenceIds including the current diff, and a summary covering requirement mismatch, regressions, edge cases and unrelated changes. If requirements or review fail, report passed=false, diagnose and revise with a minimal patch. Finally provide the user a clear result."
                  : "Inspect activeFailureId and its fresh observation in working memory. For repeated failures collect new successful repository evidence; at level 3 also supply alternatives and an experiment (question, expectedResults, observationIds) with expanded search. Call diagnose with context, steps, a revised cause and evidenceIds including current failure or newer observations. Make a minimal coherent fix, including any required scripts, then call request_verification; runtime will rerun local checks before broader checks.",
              }));
              state.transcript = control.transcript();
              if (stopReason) { await finishStoppedRun(); return; }
            }
          } finally { await finishStoppedRun(); }
        },
      });
      state.transcript = bridgeResult.transcript;
      if (state.controller.signal.aborted) throw state.controller.signal.reason ?? new Error("Run cancelled");
      if (bridgeResult.errorMessage && !stopReason) {
        this.checkBudget(spec, state);
        if (state.turns > spec.budget.maxTurns) throw new BudgetExceededError("model_turn_limit", "模型轮次额度已用完");
        throw new Error(bridgeResult.errorMessage);
      }
      if (stopReason) {
        this.status(spec.id, state, "review");
        this.emitEvent(spec.id, state, {
          type: "result",
          text: `${finalText.trim() || progress.fallback()}\n\n本轮待复核：${stopReason}${bridgeResult.errorMessage ? `\n收尾未完成：${bridgeResult.errorMessage}` : ""}`,
          status: "review",
          stop: buildRunStop(stopCode, stopReason, spec, state, workflow.snapshot(), summaryError ?? bridgeResult.errorMessage),
        });
        this.saveCheckpoint(spec.id, state, "manual");
        return;
      }
      const verified = workflow.needsChange ? workflow.canFinish() : workflow.checksCurrent();
      if (verified) workflow.move("done", "运行时完成门槛已通过");
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
      this.saveCheckpoint(spec.id, state, "manual");
      this.emitEvent(spec.id, state, {
        type: "result",
        text: finalText,
        status: verified ? "completed" : "review",
      });
    } catch (error) {
      const cancelled = state.controller.signal.aborted;
      // The model bridge serializes exceptions; recover budget identity from runtime counters.
      let failure = error;
      if (!cancelled && !(failure instanceof BudgetExceededError)) {
        try {
          this.checkBudget(spec, state);
          if (state.turns > spec.budget.maxTurns) failure = new BudgetExceededError("model_turn_limit", "模型轮次额度已用完");
        } catch (budgetError) {
          if (budgetError instanceof BudgetExceededError) failure = budgetError;
        }
      }
      const status: RunStatus = cancelled ? "cancelled" : failure instanceof BudgetExceededError ? "review" : "failed";
      if (transitions[state.status].includes(status))
        this.status(spec.id, state, status);
      this.emitEvent(spec.id, state, {
        type: "error",
        code: cancelled ? "RUN_CANCELLED" : "RUN_FAILED",
        message: failure instanceof Error ? failure.message : String(failure),
        retryable: !cancelled,
      });
      this.saveCheckpoint(spec.id, state, "manual");
      this.emitEvent(spec.id, state, {
        type: "result",
        text: cancelled ? "Run cancelled." : failure instanceof Error ? failure.message : "Run failed.",
        status,
        ...(!cancelled ? { stop: buildRunStop(failure instanceof BudgetExceededError ? failure.code : "provider_error", failure instanceof Error ? failure.message : String(failure), spec, state, state.workflow?.snapshot()) } : {}),
      });
    }
  }

  private async authorizeTool(
    spec: RunSpec,
    state: ActiveRun,
    call: ToolCall,
    options: { approvalTtlMs?: number; commandPrefixes?: string[] } = {},
    definition?: ToolDefinition,
  ): Promise<{ block?: boolean; reason?: string; terminate?: boolean }> {
    state.toolCalls += 1;
    this.checkBudget(spec, state);
    // A runtime-owned tool is absent from the durable registry, so its caller supplies the definition.
    const tool = definition ?? this.deps.tools.get(call.name);
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
          options.commandPrefixes ?? (typeof call.input.command === "string" ? [call.input.command] : []),
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
          ...(options.approvalTtlMs !== undefined ? { ttlMs: options.approvalTtlMs } : {}),
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

  private verificationItems(profile: Profile, state: ActiveRun): Profile["verificationPolicy"]["items"] {
    return [...profile.verificationPolicy.items, ...(state.workflow?.state.verification ?? []).map((item, index) => ({ ...item, id: "task-check-" + index, required: true, expectedExitCodes: [0] }))];
  }

  /**
   * Every verification publishes exactly one started event and exactly one finished run. A budget,
   * cancellation or storage failure inside the check loop used to escape before the finished event
   * was emitted or the run was recorded, leaving `localCheck`/`broaderCheck` at their default
   * `pending` for the rest of the run. The model then reported that as a harness-level "running"
   * state, spent self-correction attempts on it and finally bypassed the tool with raw terminal calls.
   */
  private async verify(
    spec: RunSpec,
    profile: Profile,
    state: ActiveRun,
    attempt: number,
    stage: "local" | "broader",
  ): Promise<VerificationRun> {
    const verificationRunId = newId("verify");
    const startedAt = nowIso();
    this.emitEvent(spec.id, state, { type: "verification_started", verificationRunId, attempt });
    try {
      return await this.runVerification(spec, profile, state, attempt, stage, verificationRunId, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const item = this.verificationItems(profile, state).find(entry => (entry.stage ?? "local") === stage);
      const failure: VerificationRun = {
        id: verificationRunId,
        runId: spec.id,
        attempt,
        stage,
        epoch: state.workflow?.state.epoch ?? "legacy",
        revision: state.workflow?.state.revision ?? 0,
        results: [{
          itemId: item?.id ?? `${stage}-runtime-failure`,
          command: item?.command ?? "(verification did not reach a command)",
          cwd: item?.cwd ?? ".",
          exitCode: null,
          passed: false,
          required: item?.required ?? true,
          output: `verification_runtime_error: ${message}`,
          durationMs: 0,
          timedOut: false,
        }],
        passed: false,
        outcome: "failed",
        skipReason: `verification_runtime_error: ${message}`,
        startedAt,
        finishedAt: nowIso(),
      };
      this.publishVerification(spec, state, failure);
      throw error;
    }
  }

  private async runVerification(
    spec: RunSpec,
    profile: Profile,
    state: ActiveRun,
    attempt: number,
    stage: "local" | "broader",
    verificationRunId: string,
    startedAt: string,
  ): Promise<VerificationRun> {
    const items = this.verificationItems(profile, state).filter(item => (item.stage ?? "local") === stage);
    if (items.length === 0 || (stage === "broader" && state.workflow?.state.broaderPolicy === "disabled")) {
      const allowedSkip = stage === "broader" ? state.workflow?.state.broaderPolicy !== "required" : !state.workflow?.needsChange;
      const verification: VerificationRun = { id: verificationRunId, runId: spec.id, attempt, stage, epoch: state.workflow?.state.epoch ?? "legacy", revision: state.workflow?.state.revision ?? 0, results: [], passed: false, outcome: allowedSkip ? "skipped" : "failed", skipReason: allowedSkip ? (stage === "local" ? "只读任务，无代码验证项" : state.workflow?.state.broaderPolicy === "disabled" ? "Profile 策略禁用扩大验证" : "可选扩大验证未配置") : "必需验证项未配置", startedAt, finishedAt: nowIso() };
      this.publishVerification(spec, state, verification);
      return verification;
    }
    const terminal = this.deps.tools.get("terminal");
    const results: VerificationRun["results"] = [];
    for (const item of items) {
      this.checkBudget(spec, state);
      if (state.controller.signal.aborted) throw new Error("Run cancelled");
      let workspacePath = resolve(spec.workspacePath, item.cwd);
      let invalidDirectory = false;
      try { workspacePath = await confinedPath(spec.workspacePath, item.cwd); } catch { invalidDirectory = true; }
      const pathFromWorkspace = relative(resolve(spec.workspacePath), workspacePath);
      const outside = invalidDirectory || pathFromWorkspace === ".." || pathFromWorkspace.startsWith("..\\") || pathFromWorkspace.startsWith("../") || isAbsolute(pathFromWorkspace);
      const started = Date.now();
      if (state.toolCalls >= spec.budget.maxToolCalls) {
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: "Verification tool-call budget exhausted", durationMs: 0, timedOut: false });
        break;
      }
      if (!terminal || outside || !profile.toolNames.includes("terminal")) {
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: outside ? "Verification cwd escapes the workspace." : "terminal tool is unavailable", durationMs: Date.now() - started, timedOut: false });
        continue;
      }
      try { validateVerificationInput(item); }
      catch (error) {
        // Missing configuration is a recoverable setup problem, not a code failure: report it as a
        // structured item and keep the remaining items running instead of aborting the whole run.
        const message = error instanceof Error ? error.message : String(error);
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: message.startsWith("verification_config_missing") ? message : `verification_config_missing: ${message}`, durationMs: Date.now() - started, timedOut: false });
        continue;
      }
      const verificationCall: ToolCall = { id: newId("verification-call"), name: "terminal", input: { command: item.command, timeoutMs: item.timeoutMs, ...(item.stdin !== undefined ? { stdin: item.stdin } : {}) } };
      const risk = terminal.assessRisk?.(verificationCall.input) ?? terminal.contract.risk;
      const decision = this.permission.decide("terminal", verificationCall.input, risk, spec.grants, spec.workspacePath);
      if (!decision.allowed) {
        this.status(spec.id, state, "running");
        // Bound the wait by the run's own remaining duration: an approval nobody answers must not
        // hold a verification, and with it the whole run, open past its budget.
        const authorization = await this.authorizeTool(spec, state, verificationCall, { approvalTtlMs: Math.max(1_000, spec.budget.maxDurationMs - (Date.now() - state.startedAt)) });
        if (state.controller.signal.aborted) throw new Error("Run cancelled");
        if (state.status !== "verifying") this.status(spec.id, state, "verifying");
        if (authorization.block) {
          results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: "Verification permission denied: " + authorization.reason, durationMs: Date.now() - started, timedOut: false });
          break;
        }
      } else state.toolCalls += 1;
      state.pendingNonIdempotent.set(verificationCall.id, verificationCall);
      this.saveCheckpoint(spec.id, state, "verification");
      try {
        const result = await terminal.execute(
          { command: item.command, timeoutMs: Math.max(1, Math.min(item.timeoutMs, spec.budget.maxDurationMs - (Date.now() - state.startedAt))), ...(item.stdin !== undefined ? { stdin: item.stdin } : {}) },
          { runId: spec.id, workspacePath, grants: spec.grants, signal: state.controller.signal },
        );
        const output = result.output as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
        const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode, passed: result.isError !== true && output.timedOut !== true && exitCode !== null && item.expectedExitCodes.includes(exitCode), required: item.required, output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`.trim().slice(0, 64_000), durationMs: Date.now() - started, timedOut: output.timedOut === true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ itemId: item.id, command: item.command, cwd: item.cwd, exitCode: null, passed: false, required: item.required, output: message, durationMs: Date.now() - started, timedOut: /timed? out/i.test(message) });
      } finally {
        state.pendingNonIdempotent.delete(verificationCall.id);
        this.saveCheckpoint(spec.id, state, "verification");
      }
      if (results.at(-1)?.passed === false) break;
    }
    const verification: VerificationRun = { id: verificationRunId, runId: spec.id, attempt, stage, epoch: state.workflow?.state.epoch ?? "legacy", revision: state.workflow?.state.revision ?? 0, results, passed: results.length === items.length && results.every(result => result.passed) && (stage === "broader" || !state.workflow?.needsChange || results.some(result => result.required && result.passed)), startedAt, finishedAt: nowIso() };
    verification.outcome = verification.passed ? "passed" : "failed";
    this.publishVerification(spec, state, verification);
    return verification;
  }

  /**
   * Publish a terminal verification run: persist it, emit the finished event, record it on the
   * workflow and checkpoint. The finished event is emitted before the workflow record, and the
   * checkpoint is best-effort, so neither a stale epoch/revision nor a storage failure can swallow
   * the event and leave a check pending for the rest of the run.
   */
  private publishVerification(spec: RunSpec, state: ActiveRun, verification: VerificationRun): void {
    this.deps.database.saveVerificationRun(verification);
    this.emitEvent(spec.id, state, { type: "verification_finished", verification });
    try { state.workflow?.recordVerification(verification); } catch { /* a stale result stays unrecorded */ }
    try { this.saveCheckpoint(spec.id, state, "verification"); } catch { /* the run survives a failed checkpoint */ }
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
      repairAttemptsUsed: state.repairAttemptsUsed,
      pendingNonIdempotentToolCalls: [...state.pendingNonIdempotent.values()],
      ...(state.workflow ? { workflow: state.workflow.snapshot() } : {}),
      createdAt: nowIso(),
    };
    this.deps.database.saveCheckpoint(checkpoint);
    this.emitEvent(runId, state, { type: "checkpoint_saved", checkpointId: checkpoint.id, reason });
    return checkpoint;
  }

  private checkBudget(spec: RunSpec, state: ActiveRun): void {
    if (state.toolCalls > spec.budget.maxToolCalls)
      throw new BudgetExceededError("tool_call_limit", "Tool-call budget exceeded");
    if (state.spentUsd > spec.budget.maxUsd)
      throw new BudgetExceededError("cost_limit", "Cost budget exceeded");
    if (Date.now() - state.startedAt > spec.budget.maxDurationMs)
      throw new BudgetExceededError("duration_limit", "Run duration budget exceeded");
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
