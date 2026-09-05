import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime, profileFor, type HarnessRuntime } from "@harness/core";
import { FeishuConnector, PairingService, TelegramConnector, type MessageConnector, type RemoteMessage } from "@harness/extensions";
import {
  DaemonRequestSchema,
  type DaemonRequest,
  type DaemonResponse,
  type AgentEvent,
  newId,
  nowIso
} from "@harness/protocol";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* .env is optional */ }
}

const passphrase = process.env.HARNESS_APP_PASSPHRASE ?? await readPassphrase();
if (!passphrase) {
  process.stderr.write("HARNESS_APP_PASSPHRASE is required to unlock the local encrypted vault.\n");
  process.exit(2);
}

const pipePath = process.platform === "win32" ? "\\\\.\\pipe\\harness-agent-v2" : join(tmpdir(), "harness-agent-v2.sock");
if (process.platform !== "win32" && existsSync(pipePath)) unlinkSync(pipePath);

const runtime = await createRuntime({ passphrase, ...(process.env.HARNESS_APP_DATA_PATH ? { appDataPath: process.env.HARNESS_APP_DATA_PATH } : {}) });
const pairing = new PairingService();
const connectors = new Map<string, MessageConnector>();
const remoteRuns = new Map<string, { connector: MessageConnector; chatId: string }>();
const connectorController = new AbortController();

configureConnectors();
runtime.engine.on("event", (event: AgentEvent) => void notifyRemote(event));

const server = createServer((socket) => handleSocket(socket));
server.listen(pipePath, () => process.stdout.write(`Harness Agent daemon listening on ${pipePath}\n`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void (async () => {
    connectorController.abort();
    server.close();
    await runtime.close();
    process.exit(0);
  })());
}

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
  switch (request.method) {
    case "health":
      return { status: "ok", version: "1.2.0", activeRuns: "available", connectors: [...connectors.keys()] };
    case "run.start": {
      target.engine.start(request.params, profileFor(target, request.params.profileId));
      return { runId: request.params.id };
    }
    case "run.resume": {
      const previous = target.database.getRun(request.params.runId);
      if (!previous) throw new Error(`Unknown run: ${request.params.runId}`);
      target.engine.resume(previous.spec.id, profileFor(target, previous.spec.profileId));
      return { runId: previous.spec.id };
    }
    case "run.cancel":
      return { cancelled: target.engine.cancel(request.params.runId) };
    case "run.events":
      return target.database.listEvents(request.params.runId, request.params.afterSequence);
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
      return target.database.listMemories(request.params?.scopeId);
    case "memory.decide":
      return target.memory.decide(request.params.memoryId, request.params.approved, request.params.actor);
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
      const updated = { ...current, memoryScopes: [...new Set(request.params.memoryScopes)] };
      target.database.saveProfile(updated);
      target.profiles.set(updated.id, updated);
      return updated;
    }
    case "skills.list":
      return Promise.all((await target.skills.discover(request.params?.workspacePath ?? process.env.HARNESS_REMOTE_WORKSPACE)).map(async (skill) => {
        const registered = target.database.listSkills().find((item) => item.sourcePath === skill.manifest.sourcePath);
        return registered?.trustedHash ? target.skills.load(skill.manifest.sourcePath, registered.trustedHash) : skill;
      }));
    case "skills.trust": {
      const inspected = await target.skills.load(request.params.sourcePath);
      const trusted = await target.skills.load(request.params.sourcePath, inspected.hash);
      target.database.saveSkill(trusted.manifest);
      return trusted;
    }
    case "skills.untrust": {
      const skill = target.database.listSkills().find((item) => item.id === request.params.skillId);
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
    case "connectors.pairing":
      if (!connectors.has(request.params.connector)) throw new Error(`${request.params.connector} is not configured`);
      return { connector: request.params.connector, code: pairing.create(request.params.connector), expiresInSeconds: 600 };
    case "attachment.put": {
      const bytes = Buffer.from(request.params.base64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 30_000_000) throw new Error("Attachment must be between 1 byte and 30 MB");
      const detected = sniffImage(bytes);
      if (!detected || detected !== request.params.mimeType) throw new Error(`Image content does not match declared MIME type (${request.params.mimeType})`);
      const attachment = await target.blobs.put({ bytes, mimeType: detected, source: request.params.source, allowedProviders: request.params.allowedProviders });
      target.database.saveAttachment(attachment);
      return attachment;
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
    sessionId: `${connector.id}:${message.chatId}`,
    request: text,
    workspacePath,
    profileId: profile.id,
    attachments,
    budget: profile.budget,
    grants: [],
    createdAt: nowIso()
  };
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

function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
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
