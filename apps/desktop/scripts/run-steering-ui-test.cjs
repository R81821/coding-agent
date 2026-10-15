// Run after pnpm --filter @harness/desktop build. Exercise the production renderer
// and IPC guard in isolated Electron storage, without a daemon, vault or providers.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
const guardPath = path.join(root, "apps/desktop/src/renderer-ipc.ts");
const guardModule = new Module(guardPath, module);
guardModule._compile(ts.transpileModule(fs.readFileSync(guardPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, guardPath);
const { sanitizeRendererRequest } = guardModule.exports;
const scratch = fs.mkdtempSync(path.join(root, ".cache/run-steering-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();
const at = "2026-10-14T00:00:00.000Z";
const workspacePath = "D:/fixture-steering-project";
const profile = {
  id: "default", name: "Developer", allowedProviders: ["openai-compatible"], preferredModels: [],
  skillIds: [], pluginIds: [], toolNames: [],
  budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 },
  routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {},
  verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture",
};
const model = {
  providerId: "openai-compatible", modelId: "fixture-model", displayName: "Fixture Model", healthy: true,
  capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 1000000, dataPolicy: "cloud" },
};
const names = ["ack", "terminal", "rpc", "modified", "late-accept", "late-error", "double", "partial", "fast", "withdraw", "withdraw-legacy", "withdraw-completed", "b"];
const sessions = new Map(names.map(id => [id, {
  id, workspacePath, profileId: "default", title: `测试 ${id}`, createdAt: at, updatedAt: at, reasoningEffort: null,
}]));
const runs = new Map(names.filter(id => id !== "b").map(id => {
  const runId = `run_${id}`;
  return [runId, {
    spec: { id: runId, sessionId: id, request: `已暂停 ${id}`, workspacePath, profileId: "default", reasoningEffort: null, taskMode: "auto", attachments: [], grants: [], budget: profile.budget, createdAt: at },
    status: "paused",
    events: [
      { id: `event_${id}_turn`, runId, at, sequence: 0, type: "assistant_turn_started" },
      { id: `event_${id}_text`, runId, at, sequence: 1, type: "text_delta", delta: `发送前的回复 ${id}` },
      { id: `event_${id}`, runId, at, sequence: 2, type: "status", status: "paused" },
    ],
  }];
}));
const requests = [];
const pending = [];
const rendererErrors = [];
let win;
const checks = [];
const sessionRuns = id => [...runs.values()].filter(run => run.spec.sessionId === id);
const requestCount = method => requests.filter(request => request.method === method).length;
async function fixtureRequest(request) {
  requests.push(request);
  const params = request.params ?? {};
  switch (request.method) {
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "mcp.interactions.list": return { requests: [] };
    case "sessions.list": return {
      items: [...sessions.values()].map(session => {
        const owned = sessionRuns(session.id);
        const latest = owned.at(-1);
        return { ...session, runCount: owned.length, ...(latest ? { latestRunId: latest.spec.id, latestStatus: latest.status } : {}) };
      }), hasMore: false,
    };
    case "projects.list": return [{ id: "project", workspacePath, createdAt: at, updatedAt: at }];
    case "session.view": return { session: sessions.get(params.sessionId), runs: sessionRuns(params.sessionId), hasMore: false };
    case "run.steer": return new Promise((resolve, reject) => pending.push({ params, resolve, reject }));
    case "run.pause": {
      const run = runs.get(params.runId);
      assert.equal(run.status, "running");
      addEvent(params.runId, { type: "status", status: "paused" });
      addEvent(params.runId, { type: "result", text: "运行已暂停。可以继续，或补充说明后再继续。", status: "paused" });
      return { pausing: true };
    }
    case "run.withdraw": {
      const run = runs.get(params.runId);
      assert.ok(run, "withdrawal references a known fixture run");
      assert.equal(run.status, "paused", "only a paused run can withdraw a message");
      assert.ok(params.messageId, "message withdrawal includes its explicit message ID");
      const latest = run.events.findLast(event => event.type === "steering_submitted");
      assert.equal(params.messageId, latest.messageId, "only the newest human message can be withdrawn");
      assert.equal(latest.withdrawable, true, "legacy messages have no fabricated rollback boundary");
      const sequence = (run.events.at(-1)?.sequence ?? -1) + 1;
      run.events = run.events.filter(event => event.sequence < latest.sequence);
      run.events.push({ id: `event_${params.runId}_${sequence}`, runId: params.runId, at, sequence, type: "status", status: "paused" });
      return { run: run.spec, withdrawnRunIds: [], messageId: params.messageId, text: latest.text };
    }
    case "run.start": {
      runs.set(params.id, { spec: params, status: "paused", events: [] });
      return { runId: params.id };
    }
    case "run.eventPage": {
      const run = runs.get(params.runId);
      assert.ok(run, `Unknown fixture run ${params.runId}`);
      const events = run.events.filter(event => event.sequence > (params.afterSequence ?? -1));
      return { runId: params.runId, status: run.status, events, nextSequence: run.events.at(-1)?.sequence ?? params.afterSequence ?? -1, hasMore: false };
    }
    default: return [];
  }
}
ipcMain.handle("harness:request", (_event, request) => {
  const sanitized = sanitizeRendererRequest(request.method, request.params);
  return fixtureRequest({ ...request, ...sanitized });
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');window.addEventListener('error',event=>console.error(event.error?.stack ?? event.message));contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),
  providerSettings:async()=>({}),desktopCommand:async()=>{},setTitlebarTheme:async()=>{},
  browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),
  onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
const evaluate = code => win.webContents.executeJavaScript(code);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(code)) { checks.push(label); return; }
    await delay(30);
  }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
async function waitPending(runId, count = 1) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && pending.filter(item => item.params.runId === runId).length < count) await delay(20);
  assert.equal(pending.filter(item => item.params.runId === runId).length, count, `Expected ${count} steering request(s) for ${runId}`);
  return pending.filter(item => item.params.runId === runId).at(-1);
}
async function openSession(id) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.querySelector('.history-session-content')?.textContent === ${JSON.stringify(`测试 ${id}`)}).click()`);
  await waitFor(`document.querySelector('.history-session.active .history-session-content')?.textContent === ${JSON.stringify(`测试 ${id}`)} && !document.querySelector('.new-task-button').disabled`, `opened ${id}`);
  if (id !== "b") await waitFor(`document.body.innerText.includes(${JSON.stringify(`已暂停 ${id}`)})`, `loaded ${id} conversation`);
}
async function setDraft(text) {
  await evaluate(`(() => { const field=document.querySelector('.prompt-textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('.prompt-textarea').value === ${JSON.stringify(text)}`, "draft reflects input");
}
async function submit() {
  await waitFor("document.querySelector('.prompt-send') && !document.querySelector('.prompt-send').disabled", "draft can be sent");
  await evaluate("document.querySelector('.prompt-send').click()");
}
async function assertDraft(text, label) {
  await waitFor(`document.querySelector('.prompt-textarea').value === ${JSON.stringify(text)}`, label);
}
function assertNoNewRun(label) {
  assert.equal(requestCount("run.start"), 0, label);
  checks.push(label);
}
function addEvent(runId, value) {
  const run = runs.get(runId);
  const sequence = (run.events.at(-1)?.sequence ?? -1) + 1;
  const event = { id: `event_${runId}_${sequence}`, runId, at, sequence, ...value };
  run.events.push(event);
  if (value.type === "status") run.status = value.status;
  return event;
}
function acceptSteering(operation, options = {}) {
  const { runId, text } = operation.params;
  assert.equal(operation.params.resumePaused, true, "paused send uses one atomic steer/resume request");
  checks.push(`atomic send request ${runId}`);
  const messageId = `steering_${runId}`;
  addEvent(runId, { type: "steering_submitted", messageId, text, ...(options.withdrawable ? { withdrawable: true } : {}) });
  const status = options.resumeError ? "paused" : "running";
  addEvent(runId, { type: "status", status });
  const result = { accepted: true, queued: 1, status, messageId, resumed: !options.resumeError, ...(options.resumeError ? { resumeError: options.resumeError } : {}) };
  return { result, messageId };
}
function finishSteering(runId, messageId, answer) {
  addEvent(runId, { type: "steering_delivered", messageId, text: requests.find(item => item.method === "run.steer" && item.params.runId === runId).params.text });
  const start = addEvent(runId, { type: "assistant_turn_started" });
  addEvent(runId, { type: "text_delta", delta: answer });
  addEvent(runId, { type: "result", text: answer, status: "completed", sourceAssistantTurnSequence: start.sequence });
  addEvent(runId, { type: "status", status: "completed" });
}
async function assertHuman(text, label) {
  await waitFor(`[...document.querySelectorAll('.user-message')].filter(el=>el.textContent === ${JSON.stringify(text)}).length === 1`, label);
}
async function assertAssistant(text, label) {
  await waitFor(`[...document.querySelectorAll('.assistant-message')].some(el=>el.textContent.includes(${JSON.stringify(text)}))`, label);
}
async function assertRunning(label) {
  await waitFor("document.querySelector('.prompt-send[aria-label=暂停]') && !document.querySelector('.prompt-send[aria-label=继续]')", label);
}
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => rendererErrors.push(String(error)));
  win.webContents.on("console-message", (event) => { if (event.level === "error") rendererErrors.push(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "production renderer ready");

  await openSession("ack");
  await setDraft("请补充单元测试");
  await submit();
  const ack = await waitPending("run_ack");
  assert.equal(ack.params.text, "请补充单元测试");
  await assertDraft("请补充单元测试", "paused steering keeps draft while acknowledgement is pending");
  assertNoNewRun("paused steering does not start a second run");
  const ackAccepted = acceptSteering(ack);
  ack.resolve(ackAccepted.result);
  await assertDraft("", "accepted steering clears the unchanged draft");
  await assertHuman("请补充单元测试", "paused send displays one standard human message");
  await assertRunning("paused send automatically resumes the original run");
  fs.writeFileSync(path.join(scratch, "paused-send-running.png"), (await win.webContents.capturePage()).toPNG());
  assert.equal(await evaluate("[...document.querySelectorAll('.conversation-turn')].every(el=>el.dataset.runId === 'run_ack')"), true);
  assert.equal(requestCount("run.resume"), 0);
  assert.equal(requestCount("run.continue"), 0);
  checks.push("automatic continuation uses the same run without a second resume or continue RPC");
  finishSteering("run_ack", ackAccepted.messageId, "已经根据补充消息重新思考并添加测试。");
  await assertAssistant("已经根据补充消息重新思考并添加测试。", "resumed run renders the new assistant answer");
  await assertHuman("请补充单元测试", "submitted and delivered events render one human message");
  await waitFor("!document.querySelector('.prompt-send[aria-label=暂停]')", "resumed run reaches the completed state");
  const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await reloaded;
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "renderer reloads from persisted fixture events");
  await openSession("ack");
  await assertHuman("请补充单元测试", "reload retains exactly one submitted human message");
  await assertAssistant("已经根据补充消息重新思考并添加测试。", "reload retains the assistant answer after steering");
  fs.writeFileSync(path.join(scratch, "paused-send-completed.png"), (await win.webContents.capturePage()).toPNG());
  assert.equal(await evaluate("document.querySelectorAll('.conversation-turn').length"), 1);
  checks.push("reload preserves one original run instead of adding a new round");

  await openSession("terminal");
  await setDraft("结束后不要丢失这条消息");
  await submit();
  const terminal = await waitPending("run_terminal");
  addEvent("run_terminal", { type: "status", status: "completed" });
  terminal.resolve({ accepted: false, queued: 0, status: "completed" });
  await assertDraft("结束后不要丢失这条消息", "terminal rejection preserves the draft");
  await waitFor("document.querySelector('.history-session.active .session-status-completed') && !document.querySelector('[aria-label=继续]')", "terminal rejection refreshes the completed state");
  assertNoNewRun("terminal rejection never starts a replacement automatically");

  await openSession("rpc");
  await setDraft("RPC 失败也保存输入");
  await submit();
  const rpc = await waitPending("run_rpc");
  rpc.reject(new Error("fixture steering RPC failed"));
  await waitFor("document.querySelector('.history-error')?.textContent.includes('fixture steering RPC failed')", "steering RPC error is visible in its own session");
  await assertDraft("RPC 失败也保存输入", "steering RPC failure preserves input");
  assertNoNewRun("RPC failure has no automatic new run");

  await openSession("modified");
  await setDraft("已经提交的旧补充");
  await submit();
  const modified = await waitPending("run_modified");
  await setDraft("等待期间改写的新补充");
  const modifiedAccepted = acceptSteering(modified);
  modified.resolve(modifiedAccepted.result);
  await delay(100);
  await assertDraft("等待期间改写的新补充", "acknowledgement does not clear a draft edited in flight");
  await assertHuman("已经提交的旧补充", "edited draft does not replace the persisted human message");
  finishSteering("run_modified", modifiedAccepted.messageId, "已处理提交的旧补充。");
  await assertAssistant("已处理提交的旧补充。", "edited draft remains independent of the resumed answer");

  await openSession("late-accept");
  await setDraft("切换前提交的补充");
  await submit();
  const lateAccept = await waitPending("run_late-accept");
  await openSession("b");
  await setDraft("另一个会话的输入");
  const lateAccepted = acceptSteering(lateAccept);
  lateAccept.resolve(lateAccepted.result);
  await delay(100);
  await assertDraft("另一个会话的输入", "late acknowledgement never clears another session's input");
  assert.equal(await evaluate("document.querySelector('.history-error')?.textContent ?? ''"), "");
  assert.equal(await evaluate("[...document.querySelectorAll('.user-message')].some(el=>el.textContent === '切换前提交的补充')"), false);
  checks.push("late accepted human message does not leak into another conversation");
  finishSteering("run_late-accept", lateAccepted.messageId, "已在原会话继续处理。");
  await openSession("late-accept");
  await assertDraft("", "late accepted steering clears only its own saved unchanged draft");
  await assertHuman("切换前提交的补充", "returning to the original session shows its persisted human message once");
  await assertAssistant("已在原会话继续处理。", "background continuation output stays in its original session");

  await openSession("late-error");
  await setDraft("切换前提交后失败的补充");
  await submit();
  const lateError = await waitPending("run_late-error");
  await openSession("b");
  await assertDraft("另一个会话的输入", "other session restores its existing draft");
  lateError.reject(new Error("fixture stale-session failure"));
  await delay(100);
  await assertDraft("另一个会话的输入", "late failure never changes another session's input");
  assert.equal(await evaluate("document.querySelector('.history-error')?.textContent ?? ''"), "");
  checks.push("late RPC failure is not displayed in another session");
  await openSession("late-error");
  await assertDraft("切换前提交后失败的补充", "late failure retains the originating session's saved draft");

  await openSession("double");
  await setDraft("双击只能提交一次");
  await evaluate("(() => { const button=document.querySelector('.prompt-send'); button.click(); button.click(); })()");
  const double = await waitPending("run_double");
  await delay(100);
  assert.equal(requests.filter(request => request.method === "run.steer" && request.params.runId === "run_double").length, 1);
  checks.push("two immediate sends create one steering RPC");
  const doubleAccepted = acceptSteering(double);
  double.resolve(doubleAccepted.result);
  await assertDraft("", "one accepted double-click submission clears its draft");
  await assertHuman("双击只能提交一次", "double-click submits one visible human message");
  await assertRunning("double-click automatically resumes once");
  finishSteering("run_double", doubleAccepted.messageId, "双击消息仅处理一次。");
  await assertAssistant("双击消息仅处理一次。", "double-click produces one resumed answer");

  await openSession("partial");
  await setDraft("保存成功后恢复失败也不重复发送");
  await submit();
  const partial = await waitPending("run_partial");
  const partialAccepted = acceptSteering(partial, { resumeError: "fixture resume launch failed" });
  partial.resolve(partialAccepted.result);
  await assertDraft("", "persisted message clears the draft even when automatic resume fails");
  await assertHuman("保存成功后恢复失败也不重复发送", "persisted human message is visible when automatic resume fails");
  await waitFor("document.querySelector('.history-error')?.textContent.includes('fixture resume launch failed') && document.querySelector('.prompt-send[aria-label=继续]')", "automatic resume failure exposes retry state and saved message");
  fs.writeFileSync(path.join(scratch, "paused-send-resume-error.png"), (await win.webContents.capturePage()).toPNG());
  await delay(120);
  assert.equal(requests.filter(request => request.method === "run.steer" && request.params.runId === "run_partial").length, 1);
  checks.push("resume failure does not resubmit an already persisted user message");
  await openSession("b");
  await openSession("partial");
  await assertHuman("保存成功后恢复失败也不重复发送", "reopening a failed resume retains its submitted message once");
  await assertDraft("", "reopening a failed resume does not restore an already persisted draft");

  await openSession("fast");
  await setDraft("立即完成的补充消息");
  await submit();
  const fast = await waitPending("run_fast");
  const fastAccepted = acceptSteering(fast);
  finishSteering("run_fast", fastAccepted.messageId, "快速重新思考后完成。");
  fast.resolve({ ...fastAccepted.result, queued: 0, status: "completed" });
  await assertDraft("", "immediately completed resume clears its accepted draft");
  await assertHuman("立即完成的补充消息", "immediately completed resume still displays the human message");
  await assertAssistant("快速重新思考后完成。", "immediately completed resume displays its answer");
  await waitFor("!document.querySelector('.prompt-send[aria-label=暂停]') && !document.querySelector('.prompt-send[aria-label=继续]')", "immediately completed resume does not leave the composer running or paused");

  await openSession("withdraw");
  const originalHuman = "已暂停 withdraw";
  const originalAssistant = "发送前的回复 withdraw";
  const newHuman = "这条暂停后的误发消息需要撤回";
  await setDraft(newHuman);
  await submit();
  const withdrawal = await waitPending("run_withdraw");
  const withdrawalAccepted = acceptSteering(withdrawal, { withdrawable: true });
  withdrawal.resolve(withdrawalAccepted.result);
  await assertDraft("", "withdrawable paused submission clears its acknowledged draft");
  await assertHuman(newHuman, "withdrawable submission appears as a standard human bubble");
  await assertRunning("withdrawable submission resumes the same conversation");
  await waitFor("document.querySelectorAll('.conversation-withdraw').length === 0", "working conversation exposes no withdrawal icon");
  addEvent("run_withdraw", { type: "steering_delivered", messageId: withdrawalAccepted.messageId, text: newHuman });
  addEvent("run_withdraw", { type: "assistant_turn_started" });
  addEvent("run_withdraw", { type: "text_delta", delta: "误发消息后的执行内容，应一起移除。" });
  await evaluate("document.querySelector('.prompt-send[aria-label=暂停]').click()");
  await waitFor("document.querySelector('.prompt-send[aria-label=继续]') && document.querySelectorAll('.conversation-withdraw').length === 1", "second pause enables one latest-message withdrawal icon");
  await waitFor(`[...document.querySelectorAll('.conversation-user-turn')].find(el=>el.querySelector('.user-message')?.textContent===${JSON.stringify(newHuman)})?.querySelector('.conversation-withdraw[aria-label="撤回最新消息"]')`, "withdrawal icon belongs below the newest human bubble");
  assert.equal(await evaluate(`[...document.querySelectorAll('.conversation-user-turn')].find(el=>el.querySelector('.user-message')?.textContent===${JSON.stringify(originalHuman)})?.querySelectorAll('.conversation-withdraw').length`), 0);
  checks.push("original human bubble cannot accidentally withdraw the entire run");
  await evaluate("document.activeElement?.blur(); document.querySelector('.conversation-withdraw').closest('.conversation-user-turn').scrollIntoView({block:'center'})");
  win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  await waitFor("getComputedStyle(document.querySelector('.conversation-withdraw').parentElement).opacity === '0'", "message withdrawal icon is hidden before hover or focus");
  const hoverPoint = await evaluate("(() => { const r=document.querySelector('.conversation-withdraw').closest('.conversation-user-turn').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()");
  win.webContents.sendInputEvent({ type: "mouseMove", ...hoverPoint });
  await waitFor("getComputedStyle(document.querySelector('.conversation-withdraw').parentElement).opacity === '1'", "hovering the human bubble reveals its withdrawal icon");
  fs.writeFileSync(path.join(scratch, "paused-message-withdraw-hover.png"), (await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  await evaluate("document.querySelector('.conversation-withdraw').focus()");
  await waitFor("getComputedStyle(document.querySelector('.conversation-withdraw').parentElement).opacity === '1' && document.activeElement === document.querySelector('.conversation-withdraw')", "keyboard focus reveals the same icon");
  await evaluate("document.querySelector('.conversation-withdraw').click()");
  await assertDraft(newHuman, "withdrawn message returns to the composer");
  await waitFor(`![...document.querySelectorAll('.user-message')].some(el=>el.textContent===${JSON.stringify(newHuman)})`, "withdrawal removes only the newest human bubble");
  await assertHuman(originalHuman, "message withdrawal retains the original human bubble");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(originalAssistant)}) && !document.body.innerText.includes('误发消息后的执行内容，应一起移除。')`, "withdrawal preserves prior assistant text and removes the later execution text");
  await waitFor("document.querySelector('.history-session.active .session-status-paused') && !document.querySelector('.prompt-send[aria-label=暂停]')", "message withdrawal retains the paused run");
  const withdrawRequest = requests.find(request => request.method === "run.withdraw");
  assert.deepEqual(withdrawRequest.params, { runId: "run_withdraw", messageId: withdrawalAccepted.messageId });
  checks.push("withdrawal RPC targets the exact human message instead of deleting its original run");
  await setDraft("");
  await waitFor("document.querySelector('.prompt-send[aria-label=继续]')", "restored run can continue from its retained pause");
  fs.writeFileSync(path.join(scratch, "paused-message-withdrawn.png"), (await win.webContents.capturePage()).toPNG());
  const withdrawalReload = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await withdrawalReload;
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "renderer reloads after message withdrawal");
  await openSession("withdraw");
  await assertHuman(originalHuman, "reload retains the earlier human conversation");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(originalAssistant)}) && ![...document.querySelectorAll('.user-message')].some(el=>el.textContent===${JSON.stringify(newHuman)}) && !document.body.innerText.includes('误发消息后的执行内容，应一起移除。')`, "withdrawn message and later output do not return on reload");
  await waitFor("document.querySelector('.prompt-send[aria-label=继续]')", "reload retains the restored paused state");

  await openSession("withdraw-legacy");
  await setDraft("历史补充没有完整文件快照");
  await submit();
  const legacy = await waitPending("run_withdraw-legacy");
  legacy.resolve(acceptSteering(legacy, { resumeError: "legacy fixture stays paused" }).result);
  await assertHuman("历史补充没有完整文件快照", "legacy steering still renders its human message");
  await waitFor("document.querySelector('.prompt-send[aria-label=继续]') && document.querySelectorAll('.conversation-withdraw').length === 0", "legacy steering cannot expose a fabricated whole-round withdrawal");

  await openSession("withdraw-completed");
  await setDraft("已经完成的补充不可撤回");
  await submit();
  const completedWithdrawal = await waitPending("run_withdraw-completed");
  const completedAccepted = acceptSteering(completedWithdrawal, { withdrawable: true });
  completedWithdrawal.resolve(completedAccepted.result);
  await assertRunning("completion fixture starts from a withdrawable paused message");
  finishSteering("run_withdraw-completed", completedAccepted.messageId, "补充已经执行完成。");
  await assertAssistant("补充已经执行完成。", "completed steering retains its final assistant answer");
  await waitFor("!document.querySelector('.prompt-send[aria-label=暂停]') && document.querySelectorAll('.conversation-withdraw').length === 0", "completed message hides withdrawal even with a saved boundary");

  assertNoNewRun("all accepted messages continue their original runs");
  assert.equal(requestCount("run.resume"), 0);
  assert.equal(requestCount("run.continue"), 0);
  checks.push("atomic sends require no separate resume or continue RPC");
  assert.deepEqual(rendererErrors, []);
  return { checks, steeringRequests: requestCount("run.steer"), newRuns: requestCount("run.start"), resumeRequests: requestCount("run.resume"), scratch };
}
const timer = setTimeout(() => { console.error("Run steering UI tests timed out"); app.exit(1); }, 90000);
main().then(result => {
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0);
}).catch(async error => {
  console.error(error);
  console.error("Renderer errors:", rendererErrors);
  console.error("Fixture requests:", requests.map(request => request.method));
  if (win && !win.isDestroyed()) {
    fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(scratch, "failure.txt"), `${String(error)}\n${await evaluate("document.body.innerText").catch(() => "")}`);
  }
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
