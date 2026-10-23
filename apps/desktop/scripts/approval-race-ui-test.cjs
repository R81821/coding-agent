// Run after the desktop build. Real renderer, isolated Electron storage and mock
// daemon IPC; no user data, model, live daemon, or workspace file is touched.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "../../..");
const guardPath = path.join(root, "apps/desktop/src/renderer-ipc.ts");
const guard = new Module(guardPath, module);
guard._compile(ts.transpileModule(fs.readFileSync(guardPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, guardPath);
const { sanitizeRendererRequest } = guard.exports;
fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, ".cache/approval-race-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();

const at = "2026-10-21T00:00:00.000Z";
const workspacePath = "D:/fixture-approval-project";
const sessionId = "approval-fixture-session";
const runId = "approval-fixture-run";
const approvalId = "approval-pause-race";
const planId = "approval-paused-plan";
const profile = {
  id: "default", name: "Developer", allowedProviders: ["openai-compatible"], preferredModels: [], skillIds: [], pluginIds: [], toolNames: [],
  budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 }, routeWeights: { quality: 1, cost: 1, latency: 1 },
  contextPolicy: {}, verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture",
};
const model = { providerId: "openai-compatible", modelId: "fixture-model", displayName: "Fixture Model", healthy: true,
  capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 100000, dataPolicy: "cloud" } };
const session = { id: sessionId, workspacePath, profileId: "default", title: "审批状态同步测试", createdAt: at, updatedAt: at, reasoningEffort: null };
function pendingApproval() {
  return { id: approvalId, runId, toolName: "write_file", normalizedInput: { path: "server/marketData.ts", content: "fixture source\n" },
    risk: "write", reason: "Fixture pending write approval", requestedGrant: { toolNames: ["write_file"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write" },
    status: "pending", createdAt: at, expiresAt: "2099-10-21T00:15:00.000Z" };
}
function pendingPlan() {
  return { id: planId, runId, version: 1, status: "awaiting_approval", goal: "暂停后保留的旧版计划审批",
    steps: [{ id: "write-fixture", title: "写入市场数据", description: "继续运行后写入市场数据文件。", dependencies: [], executor: "main", mode: "write", allowedTools: ["write_file"], input: { path: "server/marketData.ts", content: "fixture source\n" }, outputContract: "市场数据文件", acceptanceCriteria: ["继续前不执行工具"], status: "pending" }],
    scope: { pathGlobs: ["server/marketData.ts"], commandPrefixes: [], networkDomains: [], maxRisk: "write" }, createdAt: at, updatedAt: at };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
let mode = "pause";
let status = "waiting_approval";
let approval = pendingApproval();
let plan = pendingPlan();
let armStaleSnapshot = false;
let staleSnapshot;
let pauseGate;
let decisionGate;
let failuresRemaining = 0;
let planDecisionGate;
let planFailuresRemaining = 0;
const requests = [], errors = [], checks = [];
let win;

function runRecord() {
  const live = status === "waiting_approval";
  const events = live ? [
    { id: "approval-status", runId, at, sequence: 0, type: "status", status },
    { id: "approval-event", runId, at, sequence: 1, type: "approval_required", approvalId, summary: "write_file (write): server/marketData.ts", risk: "write" },
  ] : [{ id: "approval-result", runId, at, sequence: 0, type: "result", status: status === "paused" ? "paused" : "completed", text: "审批测试会话" }];
  return { spec: { id: runId, sessionId, request: "验证暂停和审批状态同步。", workspacePath, profileId: "default", taskMode: "auto", attachments: [], grants: [], budget: profile.budget, createdAt: at }, status, events };
}
async function fixtureRequest(request) {
  requests.push({ ...request, fixtureMode: mode });
  switch (request.method) {
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "mcp.interactions.list": return { requests: [] };
    case "sessions.list": return { items: [{ ...session, runCount: 1, latestRunId: runId, latestStatus: status }], hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath, createdAt: at, updatedAt: at }];
    case "session.view": return { session, runs: [runRecord()], hasMore: false };
    case "run.eventPage": {
      const events = runRecord().events.filter(event => event.sequence > request.params.afterSequence);
      return { events, nextSequence: Math.max(request.params.afterSequence, ...events.map(event => event.sequence)), hasMore: false, status };
    }
    case "plan.get": return mode.startsWith("plan") ? structuredClone(plan) : undefined;
    case "plan.decide": {
      assert.equal(request.params.planId, planId);
      assert.equal(request.params.version, 1);
      assert.equal(request.params.actor, "desktop:user");
      assert.equal(status, "paused");
      if (mode === "plan-failure" && planFailuresRemaining-- > 0) throw new Error("FIXTURE_PLAN_CONNECTION_FAILURE");
      if (planDecisionGate) await planDecisionGate.promise;
      if (plan.status === "awaiting_approval") plan = { ...plan, status: request.params.approved ? "approved" : "rejected", ...(request.params.approved ? { approvedBy: "desktop:user", approvedAt: at } : {}), updatedAt: at };
      return structuredClone(plan);
    }
    case "checkpoints.get": return [];
    case "approvals.list": {
      if (mode === "pause" && armStaleSnapshot && !staleSnapshot) {
        const snapshot = structuredClone(approval);
        staleSnapshot = deferred();
        await staleSnapshot.promise;
        return [snapshot];
      }
      return mode.startsWith("plan") ? [] : [structuredClone(approval)];
    }
    case "run.pause":
      status = "paused";
      if (pauseGate) await pauseGate.promise;
      return { pausing: true };
    case "run.resume":
      assert.equal(mode, "pause");
      assert.equal(status, "paused");
      status = "waiting_approval";
      return { resumed: true };
    case "approval.decide": {
      assert.equal(request.params.approvalId, approvalId);
      assert.equal(request.params.actor, "desktop:user");
      if (mode === "failure" && failuresRemaining-- > 0) throw new Error("FIXTURE_APPROVAL_CONNECTION_FAILURE");
      if (decisionGate) await decisionGate.promise;
      if (mode === "center") approval = { ...approval, status: "denied", decidedBy: "other:user" };
      else if (approval.status === "pending") approval = { ...approval, status: request.params.approved ? "approved" : "denied", decidedBy: "desktop:user" };
      if (mode === "pause" && status === "waiting_approval") status = "completed";
      return structuredClone(approval);
    }
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "run.review": return undefined;
    case "run.start":
      throw new Error("The UI regression must not start a real run");
    default: return [];
  }
}
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
ipcMain.handle("harness:open-external", () => { throw new Error("The approval UI must not open external links"); });
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');window.addEventListener('error',event=>console.error(event.error?.stack??event.message));window.addEventListener('unhandledrejection',event=>console.error('UNHANDLED:'+String(event.reason?.stack??event.reason)));contextBridge.exposeInMainWorld('harness',{
desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),providerSettings:async()=>({}),desktopCommand:async()=>{},setTitlebarTheme:async()=>{},
browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined,openExternal:url=>ipcRenderer.invoke('harness:open-external',url)
});`);
const evaluate = code => win.webContents.executeJavaScript(code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await condition()) { checks.push(label); return; } await pause(20); }
  throw new Error(label + ": timed out\n" + await evaluate("document.body.innerText"));
}
const waitFor = (code, label, timeoutMs) => until(() => evaluate(code), label, timeoutMs);
const count = (method, scenario = mode) => requests.filter(request => request.method === method && request.fixtureMode === scenario).length;
const dialog = "document.querySelector('dialog.approval-overlay[open]')";
const dialogButton = label => `[...${dialog}.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)})`;
const center = "document.querySelector('.content article')";
const centerButton = label => `[...${center}.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)})`;
async function capture(name) {
  // DOM assertions can precede the offscreen compositor's next painted frame.
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await pause(80);
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
async function reload(nextMode) {
  mode = nextMode;
  status = nextMode === "pause" ? "waiting_approval" : nextMode.startsWith("plan") ? "paused" : "completed";
  approval = pendingApproval();
  plan = pendingPlan();
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await loaded;
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", nextMode + " fixture ready");
}
async function openCenter() {
  await evaluate("[...document.querySelectorAll('nav[aria-label=主导航] button')].find(button=>button.querySelector('.nav-icon+span')?.textContent==='审批').click()");
  await waitFor(center + " && " + center + ".textContent.includes('server/marketData.ts')", "approval center shows the recorded operation");
}
async function openPlan() {
  await evaluate("document.querySelector('details.sidebar-tools').open=true;[...document.querySelectorAll('nav[aria-label=主导航] button')].find(button=>button.querySelector('.nav-icon+span')?.textContent==='计划与验证').click()");
  await waitFor(center + " && " + center + ".textContent.includes('暂停后保留的旧版计划审批') && " + center + ".textContent.includes('awaiting_approval')", "the paused legacy plan remains available in the plan view");
}
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 920, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor(dialog + " && " + dialogButton("暂停本轮"), "the waiting tool approval opens with its pause control");
  armStaleSnapshot = true;
  await until(() => Boolean(staleSnapshot), "an in-flight approval poll holds a pending snapshot");
  pauseGate = deferred();
  await evaluate(`(() => { const stop=${dialogButton("暂停本轮")}, approve=${dialogButton("批准一次")};stop.click();approve.click();stop.click(); })()`);
  await until(() => count("run.pause") === 1, "pause sends one request despite immediate repeat clicks");
  await pause(100);
  assert.equal(count("approval.decide"), 0);
  await waitFor("document.querySelector('button[aria-label=暂停]')?.disabled===true", "the composer pause control shows the shared action lock instead of silently accepting a click");
  checks.push("an approval action cannot race the pending pause action");
  pauseGate.resolve();
  await waitFor(dialog + "===null", "a successful pause dismisses the obsolete approval dialog immediately");
  assert.equal(approval.status, "pending");
  assert.equal(approval.decidedBy, undefined);
  assert.equal(await evaluate("document.body.innerText.includes('待审批请求会保留')"), true);
  staleSnapshot.resolve();
  await pause(150);
  assert.equal(await evaluate(dialog + "===null"), true);
  checks.push("a late pending approval snapshot does not reopen the paused dialog");
  await pause(650);
  assert.equal(await evaluate(dialog + "===null"), true);
  assert.equal(count("approval.decide"), 0);
  await openCenter();
  await waitFor(center + ".textContent.includes('pending')", "pause preserves the same pending approval after the late snapshot");
  await capture("approval-paused-no-stale-dialog.png");
  await evaluate("[...document.querySelectorAll('nav[aria-label=主导航] button')].find(button=>button.querySelector('.nav-icon+span')?.textContent==='会话').click()");
  await waitFor("document.querySelector('button[aria-label=继续]')", "the paused round exposes its explicit resume control");
  await evaluate("document.querySelector('button[aria-label=继续]').click()");
  await until(() => count("run.resume") === 1, "resume uses the same paused round exactly once");
  await waitFor(dialog + " && " + dialog + ".textContent.includes('write_file')", "resume reopens the preserved approval for the same pending operation");
  assert.equal(approval.id, approvalId);
  assert.equal(approval.status, "pending");
  await capture("approval-resumed-same-operation.png");
  await evaluate(dialogButton("批准一次") + ".click()");
  await until(() => count("approval.decide") === 1 && approval.status === "approved", "the preserved approval accepts one decision after explicit resume");
  await waitFor(dialog + "===null", "the resumed approval dialog closes after its decision");

  await reload("center");
  await openCenter();
  decisionGate = deferred();
  await evaluate(`(() => { const approve=${centerButton("批准一次")}, deny=${centerButton("拒绝")};approve.click();approve.click();deny.click(); })()`);
  await until(() => count("approval.decide") === 1, "approval center duplicate and opposite clicks submit once");
  await waitFor(`[...${center}.querySelectorAll('button')].length===2 && [...${center}.querySelectorAll('button')].every(button=>button.disabled)`, "both decision buttons are disabled while their shared request is pending");
  await pause(100);
  assert.equal(count("approval.decide"), 1);
  decisionGate.resolve();
  await waitFor(center + ".textContent.includes('denied') && " + center + ".querySelectorAll('footer button').length===0", "the returned denied record replaces stale pending controls");
  assert.equal(approval.decidedBy, "other:user");
  assert.equal(approval.status, "denied");
  assert.equal(await evaluate("document.body.innerText.includes('已批准。')"), false);
  checks.push("a stale approve response never changes an existing rejection into approval");
  await capture("approval-stale-decision-synced.png");

  decisionGate = undefined;
  failuresRemaining = 1;
  await reload("failure");
  await openCenter();
  await evaluate(centerButton("批准一次") + ".click()");
  await waitFor("document.body.innerText.includes('FIXTURE_APPROVAL_CONNECTION_FAILURE')", "a transport failure is displayed as a recoverable UI error");
  await waitFor(`[...${center}.querySelectorAll('footer button')].length===2 && [...${center}.querySelectorAll('footer button')].every(button=>!button.disabled)`, "a failed request releases the decision lock for retry");
  assert.equal(approval.status, "pending");
  assert.equal(count("approval.decide"), 1);
  await capture("approval-network-error-retry.png");
  await evaluate(centerButton("批准一次") + ".click()");
  await waitFor(center + ".textContent.includes('approved') && " + center + ".querySelectorAll('footer button').length===0", "retry settles the still-pending approval normally");
  assert.equal(count("approval.decide"), 2);
  assert.equal(approval.decidedBy, "desktop:user");
  assert.equal(await evaluate("document.body.innerText.includes('FIXTURE_APPROVAL_CONNECTION_FAILURE')"), false);
  await capture("approval-retry-approved.png");

  await reload("plan");
  await openPlan();
  const pausedPlanEvents = structuredClone(runRecord().events);
  planDecisionGate = deferred();
  await evaluate(`(() => { const approve=${centerButton("批准计划")}, deny=${centerButton("拒绝")};approve.click();approve.click();deny.click(); })()`);
  await until(() => count("plan.decide") === 1, "paused plan duplicate and opposite clicks submit one decision");
  await waitFor(`[...${center}.querySelectorAll('footer button')].length===3 && [...${center}.querySelectorAll('footer button')].every(button=>button.disabled)`, "all three plan decision controls are disabled during the pending request");
  await pause(100);
  assert.equal(count("plan.decide"), 1);
  planDecisionGate.resolve();
  await waitFor(center + ".textContent.includes('approved') && " + center + ".querySelectorAll('footer button').length===0", "the paused plan view refreshes its approved state without new run events");
  assert.equal(plan.id, planId);
  assert.equal(plan.version, 1);
  assert.equal(plan.approvedBy, "desktop:user");
  assert.equal(status, "paused");
  assert.deepEqual(runRecord().events, pausedPlanEvents);
  assert.equal(count("plan.decide"), 1);
  checks.push("saving the original plan decision neither resumes the paused run nor adds events");
  await capture("approval-paused-plan-approved.png");

  planDecisionGate = undefined;
  planFailuresRemaining = 1;
  await reload("plan-failure");
  await openPlan();
  await evaluate(centerButton("批准计划") + ".click()");
  await waitFor("[...document.querySelectorAll('.content [role=alert]')].some(alert=>alert.textContent.includes('FIXTURE_PLAN_CONNECTION_FAILURE'))", "the paused plan reports a transport failure inline without an unhandled rejection");
  await waitFor(`[...${center}.querySelectorAll('footer button')].length===3 && [...${center}.querySelectorAll('footer button')].every(button=>!button.disabled)`, "a failed plan request releases all three decision controls for retry");
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(plan.approvedBy, undefined);
  assert.equal(status, "paused");
  assert.equal(count("plan.decide"), 1);
  await capture("approval-paused-plan-error-retry.png");
  await evaluate(centerButton("批准计划") + ".click()");
  await waitFor(center + ".textContent.includes('approved') && " + center + ".querySelectorAll('footer button').length===0", "retry approves the preserved paused plan and removes its obsolete decision controls");
  assert.equal(count("plan.decide"), 2);
  assert.equal(plan.id, planId);
  assert.equal(plan.version, 1);
  assert.equal(plan.approvedBy, "desktop:user");
  assert.equal(status, "paused");
  assert.deepEqual(runRecord().events, pausedPlanEvents);
  assert.equal(await evaluate("document.body.innerText.includes('FIXTURE_PLAN_CONNECTION_FAILURE')"), false);
  await capture("approval-paused-plan-retry-approved.png");
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(request => request.method === "run.start").length, 0);
  assert.equal(requests.filter(request => request.method === "run.resume").length, 1);
  return { checks, scratch, requests: requests.map(request => ({ method: request.method, fixtureMode: request.fixtureMode, ...(["approval.decide", "plan.decide"].includes(request.method) ? { params: request.params } : {}) })), screenshots: ["approval-paused-no-stale-dialog.png", "approval-resumed-same-operation.png", "approval-stale-decision-synced.png", "approval-network-error-retry.png", "approval-retry-approved.png", "approval-paused-plan-approved.png", "approval-paused-plan-error-retry.png", "approval-paused-plan-retry-approved.png"] };
}
const timer = setTimeout(() => { console.error("Approval race UI timeout"); app.exit(1); }, 45000);
main().then(result => {
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checks: result.checks.length, scratch, screenshots: result.screenshots }));
  clearTimeout(timer); app.exit(0);
}).catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, errors, requests }, null, 2));
  if (win && !win.isDestroyed()) await capture("failure.png");
  console.error("Fixture artifacts: " + scratch); clearTimeout(timer); app.exit(1);
});
