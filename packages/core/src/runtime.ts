import { waitForRunResult } from "./run-completion.js";
import { conversationTaskPrompt } from "./conversation-task-context.js";
import { recoverTaskArtifacts } from "./task-artifact-recovery.js";
import { captureGraphTaskBaseline, executeGraphTasks, graphTaskChanges, graphTaskScopeViolations, type GraphExecutionTask } from "./graph-task-execution.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { newId, nowIso, type AgentEvent, type CurrentModel, type Profile, type ReasoningEffort, type RunSpec, type SessionRecord, type TaskSpec } from "@harness/protocol";
import { EncryptedBlobStore, ensureV2Storage, HarnessDatabase, VaultCrypto, type StorageProgress } from "@harness/persistence";
import { createConfiguredProviders, ModelRouter, ParallelSearchProvider } from "@harness/providers";
import { createDefaultToolRegistry, createWebSearchTool, type ToolDefinition } from "@harness/tools";
import { MemoryService, PluginService, SkillService, TaskScheduler, WorktreeManager } from "@harness/extensions";
import { HarnessEngine } from "./engine.js";
import { ProjectTrustService } from "./project-trust.js";
import { configureTelemetry } from "./telemetry.js";
import { HarnessEvalRunner } from "@harness/evals";
import { loadProfilesWithBudgetMigration } from "./budget-migration.js";
import { SkillInstaller } from "@harness/extensions";
import { SkillJobs } from "./skill-jobs.js";
import { RunReviewService } from "./run-review.js";
import { McpStore, McpService, McpOAuthManager } from "@harness/extensions";

export interface HarnessRuntime {
  currentModel(profileId: string, needsVision?: boolean): Promise<CurrentModel>;
  setSessionReasoning(sessionId: string, effort: ReasoningEffort | null, profileId?: string, needsVision?: boolean): Promise<SessionRecord>;
  providerIds: string[];
  engine: HarnessEngine;
  database: HarnessDatabase;
  blobs: EncryptedBlobStore;
  review: RunReviewService;
  scheduler: TaskScheduler;
  memory: MemoryService;
  skills: SkillService;
  skillJobs: SkillJobs;
  projectTrust: ProjectTrustService;
  plugins: PluginService;
  mcp: McpService;
  mcpAuth: McpOAuthManager;
  search?: ParallelSearchProvider;
  reloadPlugins(): void;
  evals: HarnessEvalRunner;
  profiles: Map<string, Profile>;
  close(): Promise<void>;
}

export async function createRuntime(options: { appDataPath?: string; passphrase: string; env?: NodeJS.ProcessEnv; onStartupProgress?: (progress: StorageProgress | { stage: "unlocking" | "runtime_ready" }) => void }): Promise<HarnessRuntime> {
  const env = options.env ?? process.env;
  const appData = options.appDataPath ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "HarnessAgent");
  await ensureV2Storage(appData);
  options.onStartupProgress?.({ stage: "unlocking" });
  const crypto = await VaultCrypto.open(join(appData, "key-envelope.json"), options.passphrase);
  const database = await HarnessDatabase.open(join(appData, "harness.sqlite"), crypto, options.onStartupProgress);
  const blobs = new EncryptedBlobStore(join(appData, "blobs"), crypto);
  const providers = createConfiguredProviders({
    env,
    attachmentResolver: async (attachment) => ({ mimeType: attachment.mimeType, base64: (await blobs.read(attachment)).toString("base64") })
  });
  const profiles = loadProfilesWithBudgetMigration(database);
  const modelRouter = new ModelRouter(providers);
  const memory = new MemoryService(database);
  const telemetry = configureTelemetry(profiles.values());
  const skills = new SkillService(join(appData, "skills"));
  const projectTrust = new ProjectTrustService(database);
  const tools = createDefaultToolRegistry();
  const search = env.PARALLEL_API_KEY ? new ParallelSearchProvider(env.PARALLEL_API_KEY, env.PARALLEL_BASE_URL) : undefined;
  const skillJobs = new SkillJobs(new SkillInstaller(skills, fetch, env.GITHUB_TOKEN), providers, doc => database.saveSkill(doc.manifest), search);
  if (search) tools.register(createWebSearchTool(search));
  const plugins = new PluginService(database);
  const mcpStore = new McpStore(database);
  const mcpAuth: McpOAuthManager = new McpOAuthManager(database, mcpStore, id => mcp.invalidate(id));
  const mcp: McpService = new McpService(mcpStore, mcpAuth);
  const evals = new HarnessEvalRunner(database, providers, env);
  const pluginToolNames = new Set<string>();
  const reloadPlugins = () => {
    for (const name of pluginToolNames) tools.unregister(name);
    pluginToolNames.clear();
    for (const plugin of plugins.list()) for (const tool of plugins.tools(plugin)) { tools.register(tool); pluginToolNames.add(tool.contract.name); }
  };
  reloadPlugins();
  const worktrees = new WorktreeManager(join(appData, "worktrees"));
  const delegateTool: ToolDefinition = {
    contract: {
      name: "delegate",
      description: "Run 1-8 bounded child-agent tasks. Read tasks may run in parallel; Git write tasks receive isolated worktrees and return patches for parent review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tasks"],
        properties: {
          maxParallel: { type: "integer", minimum: 1, maximum: 8, default: 4 },
          tasks: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object", additionalProperties: false, required: ["id", "prompt", "mode"],
              properties: {
                id: { type: "string" }, prompt: { type: "string" }, mode: { enum: ["read", "write"] },
                stepId: { type: "string" }, writePaths: { type: "array", maxItems: 100, items: { type: "string" } },
              }
            }
          }
        }
      },
      risk: "high",
      idempotent: false,
      timeoutMs: 1_800_000
    },
    assessRisk: (input) => Array.isArray(input.tasks) && input.tasks.some((task) => isDelegateTask(task) && task.mode === "write") ? "high" : "read",
    execute: async (input, context) => {
      context.signal.throwIfAborted();
      const parent = database.getRun(context.runId)?.spec;
      if (!parent) throw new Error(`Parent run not found: ${context.runId}`);
      const profile = profiles.get(parent.profileId);
      if (!profile) throw new Error(`Unknown parent profile: ${parent.profileId}`);
      const tasks = Array.isArray(input.tasks) ? input.tasks : [];
      if (!tasks.length || tasks.length > 8 || !tasks.every(isDelegateTask)) throw new Error("delegate requires between 1 and 8 valid tasks");
      const maxParallel = Number(input.maxParallel ?? 4);
      const gitWorkspace = await isGitWorkspace(parent.workspacePath, context.signal);
      const childIds = new Map<string, string>();
      const outcomes = await executeGraphTasks(tasks, maxParallel, context.signal, async task => {
        const perform = async () => {
        const startedAt = nowIso();
        let lease: Awaited<ReturnType<WorktreeManager["create"]>> | undefined;
        let result: Awaited<ReturnType<typeof runDelegatedTask>> | undefined;
        let baseline: string | undefined;
        try {
          if (task.mode === "write" && gitWorkspace) lease = await engine.withConversationWorkspace(parent.id, "read", () => worktrees.create(parent.workspacePath, parent.id, task.id, context.signal), context.signal);
          const workspacePath = lease?.path ?? parent.workspacePath;
          baseline = lease ? await captureGraphTaskBaseline(workspacePath, context.signal) : undefined;
          result = await runDelegatedTask(task, parent, profile, workspacePath, startedAt, baseline);
          const changes = baseline ? await graphTaskChanges(workspacePath, baseline, context.signal) : undefined;
          const violations = changes ? graphTaskScopeViolations(task, changes.paths) : [];
          const output = {
            ...result, ...(lease ? { branch: lease.branch } : {}),
            ...(changes && !violations.length ? { patch: changes.patch, changedPaths: changes.paths } : {}),
            ...(violations.length ? { status: "failed" as const, scopeViolation: violations, text: `Child wrote outside its declared scope: ${violations.join(", ")}` } : {}),
          };
          if (task.stepId) engine.recordTaskExecution(parent.id, {
            stepId: task.stepId, taskId: task.id, childRunId: result.runId, mode: task.mode, startedAt,
            ...(database.getConversationTask(task.id) ? { attemptId: database.getConversationTask(task.id)!.attemptId!, planGeneration: database.getConversationTask(task.id)!.planGeneration } : {}),
            status: output.status === "completed" ? "completed" : output.status === "cancelled" || output.status === "paused" ? "interrupted" : "failed",
            finishedAt: nowIso(), summary: output.text.slice(0, 6000), ...(changes && !violations.length ? { patch: changes.patch } : {}),
          });
          return output;
        } catch (error) {
          // The child has settled before waitForRunResult rejects. Retain its safe partial
          // product for explicit recovery, using a cleanup signal rather than the aborted parent.
          let partialPatch: string | undefined;
          if (lease && baseline) {
            try {
              const partial = await graphTaskChanges(lease.path, baseline, AbortSignal.timeout(30000));
              if (!graphTaskScopeViolations(task, partial.paths).length) partialPatch = partial.patch;
            } catch { /* interruption remains explicit even if the partial product is unavailable */ }
          }
          if (task.stepId) engine.recordTaskExecution(parent.id, {
            stepId: task.stepId, taskId: task.id, ...(childIds.has(task.id) ? { childRunId: childIds.get(task.id)! } : {}), mode: task.mode, startedAt,
            ...(database.getConversationTask(task.id) ? { attemptId: database.getConversationTask(task.id)!.attemptId!, planGeneration: database.getConversationTask(task.id)!.planGeneration } : {}),
            status: context.signal.aborted ? "interrupted" : "failed", finishedAt: nowIso(), summary: String(error).slice(0, 6000),
            ...(partialPatch !== undefined ? { patch: partialPatch } : {}),
          });
          throw error;
        } finally { await lease?.cleanup(); }
        };
        return gitWorkspace && task.mode === "write" ? perform() : engine.withConversationTaskWorkspace(parent.id, task.mode, perform, context.signal);
      }, { allowParallelWrites: gitWorkspace });
      const results = outcomes.map((outcome, index) => outcome.status === "fulfilled" ? outcome.value : {
        taskId: outcome.taskId, ...(tasks[index]!.stepId ? { stepId: tasks[index]!.stepId } : {}), mode: tasks[index]!.mode,
        status: "failed", text: String(outcome.error),
      });
      return { output: { parentRunId: parent.id, gitWorkspace, results } };

      async function runDelegatedTask(task: DelegatedTask, parentRun: RunSpec, parentProfile: Profile, workspacePath: string, startedAt: string, baselineTree?: string) {
        const queued = database.getConversationTask(task.id);
        const childId = queued?.childRunId ?? newId("run_child");
        const divisor = Math.max(1, tasks.length);
        const readTools = new Set(["read_file", "read_range", "list_files", "search_text", "search_files", "git_diff"]);
        const childProfile: Profile = {
          ...parentProfile,
          id: `${parentProfile.id}:child`,
          toolNames: parentProfile.toolNames.filter((name) => !["delegate", "run_tasks", "wait_tasks", "integrate_tasks"].includes(name) && (task.mode === "write" || readTools.has(name))),
          budget: queued?.attempts.at(-1)?.reservation ?? engine.childBudget(parentRun.id, divisor)
        };
        const child: RunSpec = {
          id: childId,
          sessionId: parentRun.sessionId,
          request: task.prompt,
          workspacePath,
          profileId: parentRun.profileId,
          attachments: [],
          budget: childProfile.budget,
          grants: task.mode === "write" ? parentRun.grants : [],
          parentRunId: parentRun.id,
          ...(task.stepId ? { parentStepId: task.stepId } : {}),
          taskMode: task.mode === "read" ? "analysis" : "change",
          ...(parentRun.workflowVersion !== undefined ? { workflowVersion: parentRun.workflowVersion } : {}),
          mcpReadOnly: task.mode === "read",
          ...(parentRun.mcpSnapshot ? { mcpInherited: parentRun.mcpSnapshot } : {}),
          createdAt: nowIso()
        };
        let result: Extract<AgentEvent, { type: "result" }>;
        try { result = await waitForRunResult(engine, childId, context.signal, () => {
          engine.start(child, childProfile);
          childIds.set(task.id, childId);
          if (task.stepId) engine.recordTaskExecution(parentRun.id, { stepId: task.stepId, taskId: task.id, childRunId: childId, status: "running", mode: task.mode, startedAt, ...(queued ? { attemptId: queued.attemptId!, planGeneration: queued.planGeneration } : {}), ...(task.writePaths ? { writePaths: task.writePaths } : {}), ...(baselineTree ? { workspacePath, baselineTree } : {}) });
        }); }
        finally {
          const childUsage = database.listEvents(childId)
            .filter((event): event is Extract<AgentEvent, { type: "usage" }> => event.type === "usage")
            .reduce((total, event) => ({
              inputTokens: total.inputTokens + event.usage.inputTokens,
              outputTokens: total.outputTokens + event.usage.outputTokens,
              estimatedUsd: total.estimatedUsd + event.usage.estimatedUsd,
              costKnown: total.costKnown && event.usage.costKnown !== false,
            }), { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, costKnown: true });
          const childCheckpoint = database.getLatestCheckpoint(childId);
          const usage = childCheckpoint?.usage ?? childUsage;
          engine.reportChildUsage(parentRun.id, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUsd: usage.estimatedUsd, costKnown: usage.costKnown ?? false, turns: childCheckpoint?.turns ?? 0, toolCalls: childCheckpoint?.toolCalls ?? 0, cachedInputTokens: "cachedInputTokens" in usage ? usage.cachedInputTokens ?? 0 : 0, durationMs: childCheckpoint?.elapsedMs ?? 0 }, childId);
        }
        return { taskId: task.id, runId: childId, ...(task.stepId ? { stepId: task.stepId } : {}), mode: task.mode, status: result.status, text: result.text };
      }
    }
  };
  tools.register(delegateTool);
  const review: RunReviewService = new RunReviewService(join(appData, "reviews"), crypto, {
    getRun: runId => database.getRun(runId)?.spec,
    activeRuns: () => engine.activeReviewRuns(),
    activeWorkspaces: (): string[] => engine.activeWorkspacePaths(),
  });
  const configuredLimit = (name: string, fallback: number, maximum: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    return value;
  };
  const engine: HarnessEngine = new HarnessEngine({ database, providers, tools, memory, skills, projectTrust, review, mcp, blobs,
    concurrency: { tasks: configuredLimit("HARNESS_TASK_CONCURRENCY", 4, 8), queueLength: configuredLimit("HARNESS_TASK_QUEUE_LENGTH", 80, 10000), tools: configuredLimit("HARNESS_TOOL_CONCURRENCY", 4, 32), modelRequests: configuredLimit("HARNESS_MODEL_CONCURRENCY", 4, 32) },
    conversationTasks: {
      isolatedWrites: isGitWorkspace,
      execute: (task, context) => delegateTool.execute({ tasks: [{ id: task.taskId, stepId: task.stepId, prompt: conversationTaskPrompt(task), mode: task.mode, ...(task.writePaths.length ? { writePaths: task.writePaths } : {}) }], maxParallel: 1 }, context),
    },
  });
  engine.recoverInterrupted();
  await recoverTaskArtifacts(database, join(appData, "worktrees"));
  const scheduler = new TaskScheduler(database, async (task: TaskSpec) => {
    const profile = profiles.get(task.run.profileId);
    if (!profile) throw new Error(`Unknown profile: ${task.run.profileId}`);
    const run = { ...task.run, id: `${task.run.id}-${Date.now()}`, createdAt: new Date().toISOString() };
    const hasWriteGrant = run.grants.some((grant) => grant.toolNames.some((name) => ["apply_patch", "terminal", "browser", "delegate"].includes(name)));
    if (hasWriteGrant && !task.approvedPlanTemplate) throw new Error("Scheduled write tasks require an approved plan template");
    if (task.approvedPlanTemplate) database.savePlan({ ...task.approvedPlanTemplate, id: newId("plan"), runId: run.id, version: 1, status: "approved", approvedBy: task.approvedPlanTemplate.approvedBy ?? "schedule-template", approvedAt: task.approvedPlanTemplate.approvedAt ?? nowIso(), createdAt: nowIso(), updatedAt: nowIso() });
    const completion = new Promise<Extract<"Done" | "Review" | "Failed" | "Cancelled", string>>((resolveCompletion) => {
      const onEvent = (event: AgentEvent) => {
        if (event.runId !== run.id || event.type !== "result") return;
        engine.off("event", onEvent);
        resolveCompletion(event.status === "completed" ? "Done" : event.status === "review" ? "Review" : event.status === "cancelled" ? "Cancelled" : "Failed");
      };
      engine.on("event", onEvent);
    });
    engine.start(run, profile);
    return completion;
  });
  scheduler.recoverInterrupted();
  scheduler.start();
  let closing: Promise<void> | undefined;
  return {
    async currentModel(profileId, needsVision = false) {
      try {
        const profile = profiles.get(profileId);
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);
        const route = await modelRouter.route(profile, { needsVision, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 512, estimatedOutputTokens: 8192 });
        return { model: route.model };
      } catch (error) { return { model: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 600) }; }
    },
    async setSessionReasoning(sessionId, reasoningEffort, profileId, needsVision = false) {
      const available = () => {
        const detail = database.getSessionDetail(sessionId);
        if (!detail || detail.session.deletedAt) throw new Error("会话不存在");
        if (detail.runs.some(run => ["queued", "planning", "running", "verifying", "waiting_approval", "paused"].includes(run.status))) throw new Error("请等待当前任务结束后再更改推理等级");
        return detail.session;
      };
      const session = available();
      const selectedProfileId = profileId ?? session.profileId;
      const profile = profiles.get(selectedProfileId);
      if (!profile) throw new Error(`Unknown profile: ${selectedProfileId}`);
      if (reasoningEffort !== null) await modelRouter.route(profile, { needsVision, needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 512, estimatedOutputTokens: 8192, reasoningEffort });
      const current = available();
      if (current.profileId !== session.profileId) throw new Error("会话 Profile 已变更，请重新选择推理等级");
      return database.touchSession(sessionId, { profileId: selectedProfileId, reasoningEffort, updatedAt: nowIso() });
    },
    providerIds: providers.map((provider) => provider.id),
    engine,
    database,
    blobs,
    review,
    scheduler,
    memory,
    skills,
    skillJobs,
    projectTrust,
    plugins,
    mcp,
    mcpAuth,
    ...(search ? { search } : {}),
    reloadPlugins,
    evals,
    profiles,
    close() {
      return closing ??= (async () => {
        scheduler.stop();
        await engine.close();
        await skillJobs.close();
        await mcp.close();
        await mcpAuth.close();
        await telemetry.shutdown();
        database.close();
        crypto.dispose();
      })();
    }
  };
}

type DelegatedTask = GraphExecutionTask;
function isDelegateTask(value: unknown): value is DelegatedTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && !!task.id.trim() && typeof task.prompt === "string" && !!task.prompt.trim()
    && (task.mode === "read" || task.mode === "write") && (task.stepId === undefined || typeof task.stepId === "string" && !!task.stepId.trim())
    && (task.writePaths === undefined || Array.isArray(task.writePaths) && task.writePaths.length <= 100 && task.writePaths.every(path => typeof path === "string"));
}

async function isGitWorkspace(workspacePath: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const { spawn } = await import("node:child_process");
  signal.throwIfAborted();
  return new Promise((resolveGit) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath, windowsHide: true, stdio: "ignore" });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => { signal.removeEventListener("abort", abort); resolveGit(false); });
    child.on("close", (code) => { signal.removeEventListener("abort", abort); resolveGit(code === 0); });
  });
}

export function profileFor(runtime: HarnessRuntime, id: string): Profile {
  const profile = runtime.profiles.get(id);
  if (!profile) throw new Error(`Unknown profile: ${id}`);
  const pluginToolNames = runtime.plugins.list()
    .filter((plugin) => plugin.enabled && profile.pluginIds.includes(plugin.manifest.id))
    .flatMap((plugin) => plugin.manifest.tools.map((tool) => tool.name));
  return { ...profile, toolNames: [...new Set([...profile.toolNames, ...pluginToolNames])] };
}
