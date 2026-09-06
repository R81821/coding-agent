import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type Profile, type RunSpec, type TaskSpec } from "@harness/protocol";
import { EncryptedBlobStore, ensureV2Storage, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { createConfiguredProviders, ParallelSearchProvider } from "@harness/providers";
import { createDefaultToolRegistry, createWebSearchTool, type ToolDefinition } from "@harness/tools";
import { ConcurrencyPool, MemoryService, PluginService, SkillService, TaskScheduler, WorktreeManager } from "@harness/extensions";
import { HarnessEngine } from "./engine.js";
import { ProjectTrustService } from "./project-trust.js";
import { configureTelemetry } from "./telemetry.js";
import { HarnessEvalRunner } from "@harness/evals";

export interface HarnessRuntime {
  providerIds: string[];
  engine: HarnessEngine;
  database: HarnessDatabase;
  blobs: EncryptedBlobStore;
  scheduler: TaskScheduler;
  memory: MemoryService;
  skills: SkillService;
  projectTrust: ProjectTrustService;
  plugins: PluginService;
  search?: ParallelSearchProvider;
  reloadPlugins(): void;
  evals: HarnessEvalRunner;
  profiles: Map<string, Profile>;
  close(): Promise<void>;
}

export async function createRuntime(options: { appDataPath?: string; passphrase: string; env?: NodeJS.ProcessEnv }): Promise<HarnessRuntime> {
  const env = options.env ?? process.env;
  const appData = options.appDataPath ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "HarnessAgent");
  await ensureV2Storage(appData);
  const crypto = await VaultCrypto.open(join(appData, "key-envelope.json"), options.passphrase);
  const database = await HarnessDatabase.open(join(appData, "harness.sqlite"), crypto);
  const blobs = new EncryptedBlobStore(join(appData, "blobs"), crypto);
  const providers = createConfiguredProviders({
    env,
    attachmentResolver: async (attachment) => ({ mimeType: attachment.mimeType, base64: (await blobs.read(attachment)).toString("base64") })
  });
  const profiles = new Map(database.listProfiles().map((profile) => [profile.id, profile]));
  if (!profiles.has(DEFAULT_PROFILE.id)) {
    database.saveProfile(DEFAULT_PROFILE);
    profiles.set(DEFAULT_PROFILE.id, DEFAULT_PROFILE);
  }
  const memory = new MemoryService(database);
  const telemetry = configureTelemetry(profiles.values());
  const skills = new SkillService(join(appData, "skills"));
  const projectTrust = new ProjectTrustService(database);
  const tools = createDefaultToolRegistry();
  const search = env.PARALLEL_API_KEY ? new ParallelSearchProvider(env.PARALLEL_API_KEY, env.PARALLEL_BASE_URL) : undefined;
  if (search) tools.register(createWebSearchTool(search));
  const plugins = new PluginService(database);
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
              properties: { id: { type: "string" }, prompt: { type: "string" }, mode: { enum: ["read", "write"] } }
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
      const parent = database.getRun(context.runId)?.spec;
      if (!parent) throw new Error(`Parent run not found: ${context.runId}`);
      const profile = profiles.get(parent.profileId);
      if (!profile) throw new Error(`Unknown parent profile: ${parent.profileId}`);
      const tasks = Array.isArray(input.tasks) ? input.tasks.filter(isDelegateTask).slice(0, 8) : [];
      if (!tasks.length) throw new Error("delegate requires at least one valid task");
      const maxParallel = Math.max(1, Math.min(8, Number(input.maxParallel ?? 4)));
      const pool = new ConcurrencyPool(maxParallel);
      const gitWorkspace = await isGitWorkspace(parent.workspacePath, context.signal);
      const reads = tasks.filter((task) => task.mode === "read");
      const writes = tasks.filter((task) => task.mode === "write");
      const results = await Promise.all(reads.map((task) => pool.run(() => runDelegatedTask(task, parent, profile, parent.workspacePath))));
      if (gitWorkspace) results.push(...await Promise.all(writes.map((task) => pool.run(async () => {
        const lease = await worktrees.create(parent.workspacePath, parent.id, task.id, context.signal);
        try {
          const result = await runDelegatedTask(task, parent, profile, lease.path);
          const diff = await tools.get("git_diff")?.execute({}, { ...context, workspacePath: lease.path });
          return { ...result, branch: lease.branch, patch: diff?.output };
        } finally { await lease.cleanup(); }
      }))));
      else {
        for (const task of writes) results.push(await runDelegatedTask(task, parent, profile, parent.workspacePath));
      }
      return { output: { parentRunId: parent.id, gitWorkspace, results } };

      async function runDelegatedTask(task: DelegatedTask, parentRun: RunSpec, parentProfile: Profile, workspacePath: string) {
        const childId = newId("run_child");
        const divisor = Math.max(1, tasks.length);
        const readTools = new Set(["read_file", "list_files", "search_text", "git_diff"]);
        const childProfile: Profile = {
          ...parentProfile,
          id: `${parentProfile.id}:child`,
          toolNames: parentProfile.toolNames.filter((name) => name !== "delegate" && (task.mode === "write" || readTools.has(name))),
          budget: engine.childBudget(parentRun.id, divisor)
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
          createdAt: nowIso()
        };
        const completion = waitForResult(childId, context.signal);
        engine.start(child, childProfile);
        const result = await completion;
        const childUsage = database.listEvents(childId)
          .filter((event): event is Extract<AgentEvent, { type: "usage" }> => event.type === "usage")
          .reduce((total, event) => ({
            inputTokens: total.inputTokens + event.usage.inputTokens,
            outputTokens: total.outputTokens + event.usage.outputTokens,
            estimatedUsd: total.estimatedUsd + event.usage.estimatedUsd,
          }), { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
        engine.reportChildUsage(parentRun.id, childUsage);
        return { taskId: task.id, runId: childId, mode: task.mode, status: result.status, text: result.text };
      }

      function waitForResult(runId: string, signal: AbortSignal): Promise<Extract<AgentEvent, { type: "result" }>> {
        return new Promise((resolveResult, rejectResult) => {
          const onEvent = (event: AgentEvent) => {
            if (event.runId !== runId || event.type !== "result") return;
            cleanup(); resolveResult(event);
          };
          const onAbort = () => { engine.cancel(runId); cleanup(); rejectResult(signal.reason ?? new Error("Delegation cancelled")); };
          const cleanup = () => { engine.off("event", onEvent); signal.removeEventListener("abort", onAbort); };
          engine.on("event", onEvent);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  };
  tools.register(delegateTool);
  const engine = new HarnessEngine({ database, providers, tools, memory, skills, projectTrust });
  engine.recoverInterrupted();
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
  return {
    providerIds: providers.map((provider) => provider.id),
    engine,
    database,
    blobs,
    scheduler,
    memory,
    skills,
    projectTrust,
    plugins,
    ...(search ? { search } : {}),
    reloadPlugins,
    evals,
    profiles,
    async close() {
      scheduler.stop();
      await telemetry.shutdown();
      database.close();
      crypto.dispose();
    }
  };
}

interface DelegatedTask { id: string; prompt: string; mode: "read" | "write" }
function isDelegateTask(value: unknown): value is DelegatedTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.prompt === "string" && (task.mode === "read" || task.mode === "write");
}

async function isGitWorkspace(workspacePath: string, signal: AbortSignal): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveGit) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath, windowsHide: true, stdio: "ignore" });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => resolveGit(false));
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
