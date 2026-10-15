// Run after the desktop build. Production renderer, isolated Electron storage and fake IPC only.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
const guardPath = path.join(root, "apps/desktop/src/renderer-ipc.ts");
const guard = new Module(guardPath, module);
guard._compile(ts.transpileModule(fs.readFileSync(guardPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, guardPath);
const { sanitizeRendererRequest } = guard.exports;
const scratch = fs.mkdtempSync(path.join(root, ".cache/conversation-task-queue-ui-"));
app.setPath("userData", path.join(scratch, "user-data")); app.disableHardwareAcceleration();
const at = "2026-10-15T00:00:00.000Z", workspacePath = "D:/fixture-queue-project";
const profile = { id: "default", name: "Developer", allowedProviders: ["openai-compatible"], preferredModels: [], skillIds: [], pluginIds: [], toolNames: [], budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {}, verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture" };
const model = { providerId: "openai-compatible", modelId: "fixture-model", displayName: "Fixture Model", healthy: true, capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 100000, dataPolicy: "cloud" } };
const sessions = new Map(["a", "b"].map(id => [id, { id, workspacePath, profileId: "default", title: `队列会话 ${id}`, createdAt: at, updatedAt: at, reasoningEffort: null }]));
const runs = new Map(["a", "b"].map(id => [`run-${id}`, {
  spec: { id: `run-${id}`, sessionId: id, request: `原始任务 ${id}`, workspacePath, profileId: "default", reasoningEffort: null, taskMode: "auto", attachments: [], grants: [], budget: profile.budget, createdAt: at }, status: "paused",
  events: [{ id: `context-${id}`, runId: `run-${id}`, at, sequence: 0, type: "context_usage", context: { usedTokens: 4900, capacityTokens: 100000, source: "provider" } }, { id: `status-${id}`, runId: `run-${id}`, at, sequence: 1, type: "status", status: "paused" }],
}]));
const limits = { maxConcurrentTasks: 4, maxQueueLength: 80 };
const row = (taskId, executionState, extra = {}) => ({ taskId, sessionId: "a", parentRunId: "run-a", stepId: taskId, planGeneration: 1, queueVersion: 1, source: { kind: "run" }, executionState, mode: "read", prompt: `任务内容 ${taskId}`, dependsOn: [], priority: 0, attempts: [], acceptanceState: "pending", createdAt: at, updatedAt: at, ...extra });
const tasks = new Map([
  row("queued", "queued"), row("blocked", "blocked", { dependsOn: ["validated-step"], blockedReason: "等待验证回执" }), row("running", "running", { startedAt: at }),
  row("integration", "awaiting_integration", { summary: "补丁等待主任务集成", patch: { path: "a.ts" } }),
  row("failed", "failed", { error: "fixture check failed" }), row("interrupted", "interrupted"),
  row("other-session", "queued", { sessionId: "b", parentRunId: "run-b", prompt: "其他会话的独立任务" }),
].map(task => [task.taskId, task]));
const requests = [], errors = [], checks = [];
let heldRead, holdNextA = false, retryAllowed = false, win;
const queue = sessionId => ({ tasks: [...tasks.values()].filter(task => task.sessionId === sessionId), limits });
async function fixtureRequest(request) {
  requests.push(request); const params = request.params ?? {};
  switch (request.method) {
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "mcp.interactions.list": return { requests: [] };
    case "sessions.list": return { items: [...sessions.values()].map(session => ({ ...session, runCount: 1, latestRunId: `run-${session.id}`, latestStatus: "paused" })), hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath, createdAt: at, updatedAt: at }];
    case "session.view": return { session: sessions.get(params.sessionId), runs: [runs.get(`run-${params.sessionId}`)], hasMore: false };
    case "conversationTasks.list":
      if (holdNextA && params.sessionId === "a") { holdNextA = false; return new Promise(resolve => { heldRead = resolve; }); }
      return queue(params.sessionId);
    case "conversationTasks.cancel": {
      const task = tasks.get(params.taskId); assert.equal(task.sessionId, params.sessionId); assert.equal(task.parentRunId, params.parentRunId);
      assert.ok(["queued", "blocked"].includes(task.executionState)); task.executionState = "cancelled"; task.queueVersion++; return task;
    }
    case "conversationTasks.retry": {
      const task = tasks.get(params.taskId); assert.equal(task.sessionId, params.sessionId); assert.equal(task.parentRunId, params.parentRunId);
      assert.ok(["failed", "interrupted"].includes(task.executionState)); assert.ok(params.reason.trim());
      if (!retryAllowed) throw new Error("请先继续父对话，再重试任务");
      task.executionState = "queued"; task.retryReason = params.reason; task.queueVersion++; return task;
    }
    default: return [];
  }
}
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');window.addEventListener('error',event=>console.error(event.error?.stack ?? event.message));contextBridge.exposeInMainWorld('harness',{
 desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),providerSettings:async()=>({}),desktopCommand:async()=>{},setTitlebarTheme:async()=>{},
 browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
const evaluate = code => win.webContents.executeJavaScript(code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await evaluate(code)) { checks.push(label); return; } await pause(30); }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
const click = code => evaluate(`${code}.click()`);
async function openSession(id) {
  await click(`[...document.querySelectorAll('.history-session')].find(el=>el.querySelector('.history-session-content')?.textContent===${JSON.stringify(`队列会话 ${id}`)})`);
  await waitFor(`document.querySelector('.history-session.active .history-session-content')?.textContent===${JSON.stringify(`队列会话 ${id}`)} && document.body.innerText.includes(${JSON.stringify(`原始任务 ${id}`)})`, `opened ${id}`);
}
const taskNode = id => `document.querySelector('[data-task-id="${id}"]')`;
async function main() {
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "production renderer ready");
  await openSession("a");
  await waitFor("document.querySelectorAll('[data-task-id]').length===6 && document.querySelector('.conversation-task-queue summary').textContent.includes('1 / 4 执行中 · 2 等待 · 1 待集成')", "queue distinguishes running, waiting and integration");
  assert.equal(await evaluate("document.querySelectorAll('.prompt-context-meter').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.prompt-textarea').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.user-message').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.history-session').length"), 2);
  checks.push("queue preserves one context bar, composer and original human bubble without child sessions");
  assert.equal(await evaluate(`${taskNode("running")}.querySelectorAll('button').length`), 0);
  await waitFor("document.body.innerText.includes('等待原因：等待验证回执') && document.body.innerText.includes('失败原因：fixture check failed') && document.body.innerText.includes('包含补丁')", "failure, block and artifact evidence is visible");
  await evaluate(`${taskNode("interrupted")}.querySelector('button').scrollIntoView({block:'end'})`);
  await waitFor(`(() => { const button=${taskNode("interrupted")}.querySelector('button').getBoundingClientRect(); const panel=document.querySelector('.conversation-task-queue').getBoundingClientRect(); return button.bottom<=panel.bottom && button.top>=panel.top; })()`, "last queue action remains reachable inside the bounded panel");
  await evaluate("document.querySelector('.conversation-task-queue').scrollTop=0");
  await click(`${taskNode("queued")}.querySelector('button')`);
  await waitFor(`${taskNode("queued")}.textContent.includes('已取消')`, "queued cancellation refreshes its durable state");
  assert.deepEqual(requests.find(request => request.method === "conversationTasks.cancel").params, { sessionId: "a", parentRunId: "run-a", taskId: "queued" });
  await click(`${taskNode("failed")}.querySelector('button')`);
  assert.equal(await evaluate(`${taskNode("failed")}.querySelector('[type=submit]').disabled`), true);
  await evaluate(`(() => { const field=${taskNode("failed")}.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'已核对上次产物，重新检查接口'); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(`!${taskNode("failed")}.querySelector('[type=submit]').disabled`, "retry requires an explicit nonempty reason");
  await click(`${taskNode("failed")}.querySelector('[type=submit]')`);
  await waitFor("document.querySelector('.conversation-task-error[role=alert]')?.textContent.includes('请先继续父对话')", "paused parent rejection is explained without auto-resume");
  retryAllowed = true;
  await click(`${taskNode("failed")}.querySelector('[type=submit]')`);
  await waitFor(`${taskNode("failed")}.classList.contains('conversation-task-queued')`, "reasoned retry refreshes its queue state");
  assert.deepEqual(requests.filter(request => request.method === "conversationTasks.retry").at(-1).params, { sessionId: "a", parentRunId: "run-a", taskId: "failed", reason: "已核对上次产物，重新检查接口" });
  assert.equal(requests.filter(request => request.method === "run.resume" || request.method === "run.start").length, 0);
  fs.writeFileSync(path.join(scratch, "queue.png"), (await win.webContents.capturePage()).toPNG());
  await openSession("b"); await waitFor("document.querySelectorAll('[data-task-id]').length===1 && document.body.innerText.includes('其他会话的独立任务')", "switching filters queue by current conversation");
  holdNextA = true; await openSession("a");
  const deadline = Date.now() + 10000; while (!heldRead && Date.now() < deadline) await pause(20); assert.ok(heldRead);
  await openSession("b"); await waitFor("document.querySelector('[data-task-id=other-session]')", "second conversation queue is loaded before late reply");
  heldRead(queue("a")); await pause(100);
  assert.equal(await evaluate("document.querySelectorAll('[data-task-id]').length"), 1);
  assert.equal(await evaluate("document.querySelector('[data-task-id=failed]')!==null"), false);
  checks.push("late queue replies cannot reattach a previous conversation branch");
  const reload = new Promise(resolve => win.webContents.once("did-finish-load", resolve)); win.webContents.reload(); await reload;
  await waitFor("document.querySelector('[data-task-id=other-session]')", "reload restores the selected conversation queue");
  await openSession("a"); await waitFor(`${taskNode("queued")}.textContent.includes('已取消') && ${taskNode("failed")}.classList.contains('conversation-task-queued')`, "reload retains cancellation and retry state");
  assert.deepEqual(errors, []); return { checks, scratch, queueReads: requests.filter(request => request.method === "conversationTasks.list").length };
}
const timer = setTimeout(() => { console.error("Queue UI test timeout"); app.exit(1); }, 60000);
main().then(result => { fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0); }).catch(async error => {
  console.error(error); console.error(errors);
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, errors, requests }, null, 2));
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG());
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
