import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchMcp, isMcpRequest } from "./mcp-rpc.js";
import { watchParentLifetime } from "./parent-lifetime.js";
import { ingestUploadedAttachment, sniffImage } from "./attachment-ingest.js";
import { validateFileAttachment } from "@harness/providers";
import { createRuntime, profileFor, validateSessionRunStart, type HarnessRuntime } from "@harness/core";
import { FeishuConnector, PairingService, TelegramConnector, type MessageConnector, type RemoteMessage } from "@harness/extensions";
import {
  DaemonRequestSchema,
  daemonEndpointName,
  type DaemonRequest,
  type DaemonResponse,
  type AgentEvent,
  newId,
  nowIso
} from "@harness/protocol";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* .env is optional */ }
}

let ownerExited = false;
let shutdownAfterStartup: (() => void) | undefined = undefined;
const stopParentWatch = watchParentLifetime(process.env.HARNESS_DESKTOP_PID, () => {
  ownerExited = true;
  shutdownAfterStartup?.();
});
if (ownerExited) process.exit(0);

const passphrase = process.env.HARNESS_APP_PASSPHRASE ?? await readPassphrase();
if (!passphrase) {
  process.stderr.write("HARNESS_APP_PASSPHRASE is required to unlock the local encrypted vault.\n");
  process.exit(2);
}

const endpointName = daemonEndpointName(process.env.HARNESS_DAEMON_INSTANCE);
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${endpointName}` : join(tmpdir(), `${endpointName}.sock`);
if (process.platform !== "win32" && existsSync(pipePath)) unlinkSync(pipePath);

let lastProgressAt = 0, lastProgressStage = "";
const runtime = await createRuntime({ passphrase, onStartupProgress: progress => {
  const now = Date.now();
  if (progress.stage !== lastProgressStage || now - lastProgressAt >= 500 || ("completed" in progress && progress.completed === progress.total)) {
    process.stderr.write("HARNESS_STARTUP_PROGRESS:" + JSON.stringify(progress) + "\n");
    lastProgressAt = now; lastProgressStage = progress.stage;
  }
}, ...(process.env.HARNESS_APP_DATA_PATH ? { appDataPath: process.env.HARNESS_APP_DATA_PATH } : {}) });
process.stderr.write('HARNESS_STARTUP_PROGRESS:{"stage":"runtime_ready"}\n');
const pairing = new PairingService();
const connectors = new Map<string, MessageConnector>();
const remoteRuns = new Map<string, { connector: MessageConnector; chatId: string }>();
const connectorController = new AbortController();

configureConnectors();
runtime.engine.on("event", (event: AgentEvent) => void notifyRemote(event));

const server = createServer((socket) => handleSocket(socket));
server.listen(pipePath, () => process.stdout.write(`Harness Agent daemon listening on ${pipePath}\n`));

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  stopParentWatch();
  void (async () => {
    connectorController.abort();
    server.close();
    await runtime.close();
    process.exit(0);
  })().catch((error: unknown) => {
    process.stderr.write(`Daemon shutdown failed: ${String(error)}\n`);
    process.exit(1);
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
shutdownAfterStartup = shutdown;
if (ownerExited) shutdown();

function handleSocket(socket: Socket): void {
  socket.on("error", (error: Error) => {
    process.stderr.write(`Client connection error: ${error.message}\n`);
  });
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      void dispatchLine(line).then((response) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}

async function dispatchLine(line: string): Promise<DaemonResponse> {
  let requestId = "unknown";
  try {
    const raw = JSON.parse(line) as { id?: unknown };
    requestId = typeof raw.id === "string" ? raw.id : requestId;
    const request = DaemonRequestSchema.parse(raw);
    return { id: request.id, ok: true, result: await dispatch(request, runtime) };
  } catch (error) {
    return { id: requestId, ok: false, error: { code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) } };
  }
}

async function dispatch(request: DaemonRequest, target: HarnessRuntime): Promise<unknown> {
  if (isMcpRequest(request)) return dispatchMcp(request, target);
  switch (request.method) {
    case "health":
      return { status: "ok", version: "1.4.51", activeRuns: "available", providerIds: target.providerIds, connectors: [...connectors.keys()] };
    case "model.current":
      return target.currentModel(request.params.profileId, request.params.needsVision);
    case "session.reasoning":
      return target.setSessionReasoning(request.params.sessionId, request.params.reasoningEffort, request.params.profileId, request.params.needsVision);
    case "sessions.create":
      return target.database.createSession(request.params);
    case "sessions.list":
      return target.database.listSessions(request.params);
    case "session.get":
      return target.database.getSessionDetail(request.params.sessionId);
    case "session.view":
      return target.database.getSessionView(request.params.sessionId, request.params.limit, request.params.before);
    case "run.eventPage":
      return target.database.listEventPage(request.params.runId, request.params.afterSequence, request.params.limit);
    case "run.output":
      return target.database.getOutputPage(request.params.runId, request.params.callId, request.params.offset, request.params.limit);
    case "session.skills": {
      const session = target.database.getSessionDetail(request.params.sessionId)?.session;
      if (!session || session.deletedAt) throw new Error("会话不存在");
      return target.database.touchSession(session.id, { skillSelection: [...new Set(request.params.skillSelection)], updatedAt: nowIso() });
    }
    case "session.delete": {
      target.engine.assertSessionMutationAllowed(request.params.sessionId);
      const session = target.database.deleteSession(request.params.sessionId);
      await target.review.deleteSession(request.params.sessionId);
      return session;
    }
    case "session.restore": {
      const session = target.database.restoreSession(request.params.sessionId);
      target.review.restoreSession(request.params.sessionId);
      return session;
    }
    case "session.purge": {
      target.engine.assertSessionMutationAllowed(request.params.sessionId);
      const result = target.database.purgeSession(request.params.sessionId);
      await target.review.deleteSession(request.params.sessionId);
      return result;
    }
    case "projects.list":
      return target.database.listProjects(request.params.deleted);
    case "project.delete": {
      const project = [...target.database.listProjects(false), ...target.database.listProjects(true)].find(item => item.id === request.params.projectId);
      if (project) target.engine.assertWorkspaceMutationAllowed(project.workspacePath);
      return target.database.deleteProject(request.params.projectId);
    }
    case "project.restore":
      return target.database.restoreProject(request.params.projectId);
    case "run.start": {
      validateSessionRunStart(
        target.database.getSessionDetail(request.params.sessionId),
        [...target.database.listProjects(false), ...target.database.listProjects(true)],
        request.params,
      );
      target.engine.start(request.params, profileFor(target, request.params.profileId));
      return { runId: request.params.id };
    }
    case "runs.list":
      return target.database.listRunHistory(request.params?.limit, request.params?.offset);
    case "run.get":
      return target.database.getRun(request.params.runId);
    case "run.review":
      return target.review.get(request.params.runId);
    case "review.undo":
      return target.review.undo(request.params.runId, request.params.path);
    case "run.continue": {
      const previous = target.database.getRun(request.params.runId);
      if (!previous) throw new Error(`Unknown run: ${request.params.runId}`);
      return { runId: target.engine.continueRun(previous.spec.id, profileFor(target, previous.spec.profileId), request.params.note) };
    }
    case "run.resume": {
      const previous = target.database.getRun(request.params.runId);
      if (!previous) throw new Error(`Unknown run: ${request.params.runId}`);
      target.engine.resume(previous.spec.id, profileFor(target, previous.spec.profileId));
      return { runId: previous.spec.id };
    }
    case "run.cancel":
      return { cancelled: target.engine.cancel(request.params.runId) };
    case "run.pause":
      return { pausing: target.engine.pause(request.params.runId) };
    case "run.withdraw":
      return target.engine.withdraw(request.params.runId, request.params.messageId);
    case "run.steer": {
      if (!request.params.resumePaused) return target.engine.steer(request.params.runId, request.params.text);
      const previous = target.database.getRun(request.params.runId);
      if (!previous) throw new Error(`Unknown run: ${request.params.runId}`);
      return target.engine.steerAndResume(request.params.runId, request.params.text, profileFor(target, previous.spec.profileId));
    }
    case "run.events":
      return target.database.listEvents(request.params.runId, request.params.afterSequence);
    case "conversationTasks.list":
      return target.engine.listConversationTasks(request.params.sessionId, request.params.parentRunId);
    case "conversationTasks.cancel":
      return target.engine.cancelConversationTask(request.params.sessionId, request.params.parentRunId, request.params.taskId);
    case "conversationTasks.retry":
      return target.engine.retryConversationTask(request.params.sessionId, request.params.parentRunId, request.params.taskId, request.params.reason);
    case "plan.get":
      return target.database.getPlanForRun(request.params.runId);
    case "plan.decide":
      return target.engine.decidePlan(request.params.planId, request.params.version, request.params.approved, request.params.actor, request.params.feedback);
    case "checkpoints.get":
      return target.database.listCheckpoints(request.params.runId, request.params.limit);
    case "approval.decide":
      return target.engine.approvals.decide(request.params.approvalId, request.params.approved, request.params.actor);
    case "approvals.list":
      return target.database.listApprovals();
    case "tasks.list":
      return target.database.listTasks();
    case "tasks.upsert":
      target.database.saveTask(request.params);
      return request.params;
    case "profiles.list":
      return [...target.profiles.values()];
    case "profiles.upsert":
      target.database.saveProfile(request.params);
      target.profiles.set(request.params.id, request.params);
      return request.params;
    case "memory.list":
      return target.memory.list(request.params?.scopeId);
    case "memory.create":
      return target.memory.create(request.params, request.params.actor);
    case "memory.publishPreview":
      return target.projectMemory.preview(request.params.workspacePath, request.params.memoryIds);
    case "memory.publish":
      return target.projectMemory.publish(request.params.workspacePath, request.params.memoryIds, request.params.token);
    case "memory.decide":
      return target.memory.decide(request.params.memoryId, request.params.approved, request.params.actor, request.params.replaceConflicts);
    case "memory.update":
      return target.memory.update(request.params.memoryId, request.params.patch, request.params.actor);
    case "memory.delete":
      target.memory.delete(request.params.memoryId);
      return { deleted: true };
    case "memory.export":
      return target.memory.export(request.params.memoryIds);
    case "profiles.memoryScopes": {
      const current = target.profiles.get(request.params.profileId);
      if (!current) throw new Error("Unknown profile");
      const updated = { ...current, memoryScopes: [...new Set(request.params.memoryScopes)], memoryPolicyVersion: 1 };
      target.database.saveProfile(updated);
      target.profiles.set(updated.id, updated);
      return updated;
    }
    case "skills.list":
      return Promise.all((await target.skills.discover(request.params?.workspacePath ?? process.env.HARNESS_REMOTE_WORKSPACE)).map(async (skill) => {
        const registered = target.database.listSkills().find((item) => item.sourcePath === skill.manifest.sourcePath);
        return registered?.trustedHash ? target.skills.load(skill.manifest.sourcePath, registered.trustedHash) : skill;
      }));
    case "skills.location": return { globalPath: target.skills.userSkillRoot };
    case "skills.recommend": return target.skillJobs.recommend(request.params.query, profileFor(target, request.params.profileId));
    case "skills.preview": return target.skillJobs.preview(request.params.command);
    case "skills.install": return target.skillJobs.install(request.params.previewId, request.params.skillPath, request.params.replace);
    case "skills.job": return target.skillJobs.get(request.params.jobId);
    case "skills.cancel": return target.skillJobs.cancel(request.params.jobId);
    case "skills.trust": {
      const inspected = await target.skills.load(request.params.sourcePath);
      if (request.params.expectedHash && request.params.expectedHash !== inspected.hash) throw new Error("技能在查看后发生变化，请重新查看并确认");
      const trusted = await target.skills.load(request.params.sourcePath, inspected.hash);
      if (!trusted.manifest.enabled) throw new Error("技能资源正在变化，请重新确认");
      target.database.saveSkill(trusted.manifest);
      return trusted;
    }
    case "skills.untrust": {
      const skill = target.database.listSkills().find((item) => (item.key ?? item.id) === request.params.skillId);
      if (!skill) throw new Error(`Unknown skill: ${request.params.skillId}`);
      const { trustedHash: _trustedHash, ...rest } = skill;
      target.database.saveSkill({ ...rest, enabled: false });
      return { id: skill.id, enabled: false };
    }
    case "plugins.list":
      return target.plugins.list();
    case "plugins.install":
      return target.plugins.install(request.params.sourcePath);
    case "plugins.trust":
      return target.plugins.trust(request.params.pluginId, request.params.grant);
    case "plugins.enable": {
      const plugin = await target.plugins.enable(request.params.pluginId);
      target.reloadPlugins();
      return plugin;
    }
    case "plugins.disable": {
      const plugin = target.plugins.disable(request.params.pluginId);
      target.reloadPlugins();
      return plugin;
    }
    case "search.status":
      return target.search ? { providerId: target.search.id, ...(await target.search.health()) } : { providerId: "parallel", healthy: false, detail: "PARALLEL_API_KEY is not configured" };
    case "eval.run":
      return target.evals.run(request.params?.caseIds, request.params?.live);
    case "eval.results":
      return target.database.listEvalResults();
    case "trace.query":
      return target.database.queryTraces(request.params ? {
        ...(request.params.runId ? { runId: request.params.runId } : {}),
        ...(request.params.type ? { type: request.params.type } : {}),
        limit: request.params.limit,
      } : {});
    case "trace.export": {
      const records = target.database.queryTraces({ runId: request.params.runId, limit: 100_000 });
      await writeFile(request.params.destinationPath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
      return { destinationPath: request.params.destinationPath, count: records.length };
    }
    case "project.inspect":
      return target.projectTrust.inspect(request.params.workspacePath);
    case "project.trust":
      return target.projectTrust.trust(request.params.workspacePath, request.params.files);
    case "project.scaffold":
      return target.projectTrust.scaffold(request.params.workspacePath);
    case "connectors.pairing":
      if (!connectors.has(request.params.connector)) throw new Error(`${request.params.connector} is not configured`);
      return { connector: request.params.connector, code: pairing.create(request.params.connector), expiresInSeconds: 600 };
    case "attachment.put": {
      return ingestUploadedAttachment(request.params, target, validateFileAttachment);
    }
  }
}

function configureConnectors(): void {
  if (process.env.TELEGRAM_BOT_TOKEN) connectors.set("telegram", new TelegramConnector(process.env.TELEGRAM_BOT_TOKEN));
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) connectors.set("feishu", new FeishuConnector(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET));
  for (const connector of connectors.values()) {
    connector.on("message", (message: RemoteMessage) => void handleRemote(connector, message));
    void connector.start(connectorController.signal).catch((error) => {
      if (!connectorController.signal.aborted) process.stderr.write(`${connector.id} connector stopped: ${String(error)}\n`);
    });
  }
}

async function handleRemote(connector: MessageConnector, message: RemoteMessage): Promise<void> {
  const text = message.text.trim();
  if (text.startsWith("/pair ")) {
    const success = pairing.pair(connector.id, message.actorId, text.slice(6).trim());
    await connector.send(message.chatId, success ? "配对成功。现在可以发起和审批任务。" : "配对码无效或已过期。");
    return;
  }
  if (!pairing.isPaired(connector.id, message.actorId)) return;
  if (text.startsWith("/approve ") || text.startsWith("/deny ")) {
    const approved = text.startsWith("/approve ");
    const id = text.split(/\s+/)[1];
    if (!id) return;
    const plan = runtime.database.getPlan(id);
    if (plan?.status === "awaiting_approval") runtime.engine.decidePlan(plan.id, plan.version, approved, `${connector.id}:${message.actorId}`);
    else runtime.engine.approvals.decide(id, approved, `${connector.id}:${message.actorId}`);
    await connector.send(message.chatId, approved ? "已批准。" : "已拒绝。");
    return;
  }
  if (text.startsWith("/cancel ")) {
    const runId = text.split(/\s+/)[1];
    await connector.send(message.chatId, runId && runtime.engine.cancel(runId) ? "已请求取消。" : "任务不存在或已结束。");
    return;
  }
  const workspacePath = process.env.HARNESS_REMOTE_WORKSPACE;
  if (!workspacePath) {
    await connector.send(message.chatId, "远程任务未启用：请在 daemon 配置 HARNESS_REMOTE_WORKSPACE。");
    return;
  }
  const id = newId("run");
  const profile = profileFor(runtime, "default");
  const sessionId = `${connector.id}:${message.chatId}`;
  const project = runtime.database.ensureProject(workspacePath);
  const existingSession = runtime.database.getSessionDetail(sessionId);
  if (!existingSession) {
    if (project.deletedAt) throw new Error("Remote workspace project is deleted in Harness");
    const createdAt = nowIso();
    runtime.database.createSession({ id: sessionId, workspacePath, profileId: profile.id, title: text.slice(0, 300) || `${connector.id} 会话`, createdAt, updatedAt: createdAt });
  }
  const attachments = [];
  for (const remoteAttachment of message.attachments.slice(0, 4)) {
    const bytes = await connector.download(remoteAttachment.fileId);
    if (bytes.byteLength > 30_000_000) throw new Error("Remote image exceeds 30 MB");
    const mimeType = sniffImage(bytes);
    if (!mimeType) throw new Error("Remote attachment is not a supported image");
    const attachment = await runtime.blobs.put({ bytes, mimeType, source: connector.id, allowedProviders: profile.allowedProviders });
    runtime.database.saveAttachment(attachment);
    attachments.push(attachment);
  }
  const run = {
    id,
    sessionId,
    request: text,
    workspacePath,
    profileId: profile.id,
    attachments,
    budget: profile.budget,
    grants: [],
    createdAt: nowIso()
  };
  validateSessionRunStart(
    runtime.database.getSessionDetail(sessionId),
    [...runtime.database.listProjects(false), ...runtime.database.listProjects(true)],
    run,
  );
  remoteRuns.set(id, { connector, chatId: message.chatId });
  runtime.engine.start(run, profile);
  await connector.send(message.chatId, `任务已创建：${id}`);
}

async function notifyRemote(event: AgentEvent): Promise<void> {
  const remote = remoteRuns.get(event.runId);
  if (!remote) return;
  if (event.type === "approval_required") await remote.connector.send(remote.chatId, `需要审批：${event.summary}\n批准：/approve ${event.approvalId}\n拒绝：/deny ${event.approvalId}`);
  if (event.type === "plan_approval_required") await remote.connector.send(remote.chatId, `计划 v${event.version} 需要审批：\n${event.summary.slice(0, 2_500)}\n批准：/approve ${event.planId}\n拒绝：/deny ${event.planId}`);
  if (event.type === "result") {
    await remote.connector.send(remote.chatId, `任务 ${event.status}：\n${event.text.slice(0, 3_500)}`);
    remoteRuns.delete(event.runId);
  }
}

async function readPassphrase(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  process.stdin.setEncoding("utf8");
  return new Promise((resolvePassphrase) => {
    let buffer = "";
    const timeout = setTimeout(() => resolvePassphrase(undefined), 15_000);
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      process.stdin.pause();
      resolvePassphrase(buffer.slice(0, newline).replace(/\r$/, ""));
    });
  });
}
