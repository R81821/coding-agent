// Run after the desktop build. Exercise the production renderer with isolated
// Electron storage and fake IPC; this never starts a daemon or calls a model.
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
const scratch = fs.mkdtempSync(path.join(root, ".cache/conversation-trace-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();

const at = "2026-10-15T00:00:00.000Z";
const workspacePath = "D:/fixture-trace-project";
const sessionId = "trace-fixture";
const runId = "run-trace-fixture";
const requestText = "为什么 pnpm install 在 CI 中失败？请检查锁文件并给出结论。";
const reasoningText = "先检查 pnpm 版本与锁文件，再对照官方 CI 安装规则。";
const processParagraphs = [
  ["我先核对 **安装环境**。", "接着检查 `pnpm` 与锁文件是否保持一致。"],
  ["版本已确认，接下来复现 CI 的安装步骤。", "我会根据 **实际错误输出** 判断是否需要更新 `pnpm-lock.yaml`。"],
];
const processMarkers = ["我先核对", "版本已确认，接下来复现 CI 的安装步骤。"];
const finalText = "锁文件修复结论：package.json 的版本发生变化，但 pnpm-lock.yaml 未同步。请在本地运行 pnpm install，并提交更新后的锁文件。";
const longCommand = "pnpm install --frozen-lockfile `\n  --filter @harness/desktop --reporter=append-only --config.confirmModulesPurge=false --config.strictPeerDependencies=true --config.ignoreCompatibilityDb=false";
const successOutput = "10.19.0";
const failureOutput = "ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with package.json";
const readRangeOutput = "import React from 'react';\nexport const fixtureRenderer = true;";
const failedReadOutput = "ENOENT: no such file or directory, open src/missing.ts";
const steeringText = "也核对一下构建入口。";
const successReadIds = ["call-read-package", "call-read-renderer", "call-read-renderer-next"];
const failedReadIds = ["call-read-config", "call-read-missing"];
const singletonReadIds = ["call-read-single", "call-read-before-human", "call-read-after-human"];
const probeScript = [
  "# PROBE_STDIN_BEGIN", "import json", "records = []",
  ...Array.from({ length: 40 }, (_, index) => `records.append({"row": ${index + 1}, "note": "fixture inspection row ${index + 1}"})`),
  "print(json.dumps({'inspected': len(records)}))", "# PROBE_STDIN_END",
].join("\n");
const shortProbeScript = [
  "# PROBE_STDIN_BEGIN", "import json", "records = []",
  ...Array.from({ length: 40 }, (_, index) => `records.append(${index + 1})`),
  "print(json.dumps({'inspected': len(records)}))", "# PROBE_STDIN_END",
].join("\n");
const probeFailureOutput = "PROBE_FIXTURE_ERROR: source artifact was unavailable";
const probeSuccessOutput = "PROBE_FIXTURE_OK: inspected 40 rows";
const probeFixtures = [
  { approvalId: "approval-probe-fail", callId: "call-probe-fail", command: "python -", isError: true, output: probeFailureOutput },
  { approvalId: "approval-probe-ok", callId: "call-probe-ok", command: "python3 -", isError: false, output: probeSuccessOutput },
].map((probe, index) => ({
  ...probe,
  stdin: index ? probeScript : shortProbeScript,
  // The engine stores at most 2,000 characters of the redacted input. Exercise
  // both complete and truncated records; neither should expose stdin in a title.
  approvalSummary: `probe (high): ${JSON.stringify({ command: probe.command, stdin: index ? probeScript : shortProbeScript }).slice(0, 2000)}`,
}));
const sourceUrls = ["https://pnpm.io/cli/install", "https://pnpm.io/continuous-integration"];
const profile = {
  id: "default", name: "Developer", allowedProviders: ["openai-compatible"], preferredModels: [],
  skillIds: [], pluginIds: [], toolNames: [],
  budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 },
  routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {},
  verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture",
};
const model = {
  providerId: "openai-compatible", modelId: "fixture-model", displayName: "Fixture Model", healthy: true,
  capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 100000, dataPolicy: "cloud" },
};
const session = { id: sessionId, workspacePath, profileId: "default", title: "执行过程界面测试", createdAt: at, updatedAt: at, reasoningEffort: null };
const events = [];
function addEvent(seconds, payload) {
  const sequence = events.length;
  const event = { id: `event-trace-${sequence}`, runId, at: new Date(Date.parse(at) + seconds * 1000).toISOString(), sequence, ...payload };
  events.push(event);
  return event;
}
function addRead(seconds, id, name, input, output, isError = false) {
  addEvent(seconds, { type: "tool_started", call: { id, name, input } });
  addEvent(seconds + 0.03, { type: "tool_finished", callId: id, output, durationMs: 30, isError });
}
addEvent(0, { type: "status", status: "running" });
addEvent(0, { type: "assistant_turn_started" });
addEvent(1, { type: "reasoning_summary", summary: reasoningText });
addEvent(2, { type: "text_delta", delta: processParagraphs[0][0] });
addEvent(3, { type: "text_delta", delta: `\n\n${processParagraphs[0][1]}` });
addRead(3.3, "call-read-package", "read_file", { path: "package.json" }, '{"name":"fixture-trace-project","packageManager":"pnpm@10.19.0"}');
addRead(3.5, "call-read-renderer", "read_range", { path: "apps/desktop/src/renderer.tsx", startLine: 1, endLine: 40 }, { path: "apps/desktop/src/renderer.tsx", startLine: 1, endLine: 40, content: readRangeOutput });
addRead(3.7, "call-read-renderer-next", "read_range", { path: "apps/desktop/src/renderer.tsx", startLine: 41, endLine: 80 }, { path: "apps/desktop/src/renderer.tsx", startLine: 41, endLine: 80, content: "export const fixtureTail = true;" });
addEvent(5, { type: "tool_started", call: { id: "call-version", name: "terminal", input: { command: "pnpm --version", cwd: workspacePath } } });
addEvent(6, { type: "tool_finished", callId: "call-version", output: { stdout: successOutput, stderr: "", exitCode: 0 }, durationMs: 95 });
addRead(6.01, "call-read-single", "read_file", { path: "README.md" }, "# Fixture project\nInstall with pnpm.");
addEvent(6.1, { type: "assistant_turn_started" });
addEvent(6.2, { type: "text_delta", delta: processParagraphs[1][0] });
addEvent(6.3, { type: "text_delta", delta: `\n\n${processParagraphs[1][1]}` });
addRead(6.31, "call-read-config", "read_file", { path: "tsconfig.json" }, '{"compilerOptions":{"strict":true}}');
addRead(6.35, "call-read-missing", "read_file", { path: "src/missing.ts" }, { error: failedReadOutput }, true);
addEvent(6.4, { type: "tool_started", call: { id: "call-install", name: "terminal", input: { command: longCommand, cwd: workspacePath } } });
addEvent(8, { type: "tool_finished", callId: "call-install", output: { stdout: "", stderr: failureOutput, exitCode: 1 }, durationMs: 1542, isError: true });
addRead(8.1, "call-read-before-human", "read_file", { path: "apps/desktop/package.json" }, '{"scripts":{"build":"vite build && tsup"}}');
addEvent(8.3, { type: "steering_delivered", messageId: "fixture-steering", text: steeringText });
addRead(8.4, "call-read-after-human", "read_file", { path: "apps/desktop/src/main.ts" }, "export const fixtureMain = true;");
addEvent(8.6, { type: "tool_started", call: { id: "call-search", name: "web_search", input: { query: "pnpm frozen lockfile CI install" } } });
addEvent(9, { type: "tool_finished", callId: "call-search", output: {
  searchId: "fixture-search", results: [
    { title: "pnpm install", url: sourceUrls[0], excerpts: ["Frozen lockfile installation."], trust: "untrusted_web" },
    { title: "Duplicate install result", url: sourceUrls[0], excerpts: ["The same source appeared twice."], trust: "untrusted_web" },
    { title: "Continuous Integration", url: sourceUrls[1], excerpts: ["Installing in CI."], trust: "untrusted_web" },
    { title: "Unsafe source", url: "javascript:window.__traceUnsafeExecuted=true", excerpts: ["This must never become a clickable source."], trust: "untrusted_web" },
  ], warnings: [], usage: {},
}, durationMs: 684 });
for (const [index, probe] of probeFixtures.entries()) {
  const seconds = 9.05 + index * 0.2;
  addEvent(seconds, { type: "approval_required", approvalId: probe.approvalId, summary: probe.approvalSummary, risk: "high" });
  addEvent(seconds + 0.05, { type: "tool_started", call: { id: probe.callId, name: "probe", input: { command: probe.command, stdin: probe.stdin } } });
  addEvent(seconds + 0.1, { type: "tool_finished", callId: probe.callId, output: {
    evidenceId: probe.callId, cwd: workspacePath,
    result: `${JSON.stringify({ exitCode: probe.isError ? 1 : 0, timedOut: false, truncated: false })}\n${probe.output}`,
    isError: probe.isError,
  }, durationMs: probe.isError ? 201 : 108, isError: probe.isError });
}
const finalTurn = addEvent(9.5, { type: "assistant_turn_started" });
addEvent(10, { type: "text_delta", delta: finalText });
addEvent(11, { type: "result", text: finalText, status: "completed", sourceAssistantTurnSequence: finalTurn.sequence });
const run = {
  spec: { id: runId, sessionId, request: requestText, workspacePath, profileId: "default", reasoningEffort: null, taskMode: "auto", attachments: [], grants: [], budget: profile.budget, createdAt: at },
  status: "completed", events,
};

const requests = [], openedUrls = [], errors = [], checks = [], hoverTimings = [];
let win;
async function fixtureRequest(request) {
  requests.push(request);
  switch (request.method) {
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "mcp.interactions.list": return { requests: [] };
    case "sessions.list": return { items: [{ ...session, runCount: 1, latestRunId: runId, latestStatus: "completed" }], hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath, createdAt: at, updatedAt: at }];
    case "session.view": return { session, runs: [run], hasMore: false };
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "run.review": return undefined;
    case "run.start":
    case "run.resume": throw new Error("A read-only replay must never start or resume execution");
    default: return [];
  }
}
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
ipcMain.handle("harness:open-external", (_event, url) => {
  assert.ok(sourceUrls.includes(url), `unexpected external URL: ${url}`);
  openedUrls.push(url);
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');window.addEventListener('error',event=>console.error(event.error?.stack ?? event.message));window.addEventListener('unhandledrejection',event=>console.error(String(event.reason?.stack ?? event.reason)));contextBridge.exposeInMainWorld('harness',{
desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),providerSettings:async()=>({}),desktopCommand:async()=>{},setTitlebarTheme:async()=>{},openExternal:url=>ipcRenderer.invoke('harness:open-external',url),
browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
const evaluate = code => win.webContents.executeJavaScript(code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(code)) { checks.push(label); return; }
    await pause(30);
  }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
const click = code => evaluate(`${code}.click()`);
const tool = callId => `document.querySelector('[data-tool-call-id="${callId}"]')`;
const toolTrigger = callId => `${tool(callId)}.querySelector('[data-slot=trace-collapsible-trigger]')`;
const readGroup = index => `document.querySelectorAll('[data-read-tool-group]')[${index}]`;
const readMarker = index => `${readGroup(index)}.querySelector('button[data-slot=marker]')`;
const approval = id => `document.querySelector('[data-conversation-approval="${id}"]')`;
const approvalTrigger = id => `${approval(id)}.querySelector('[data-slot=trace-collapsible-trigger]')`;
const sources = "document.querySelector('[data-conversation-sources=true]')";
const hoverCard = "document.querySelector('[data-slot=hover-card-content]:not([data-closed])')";
const finalOccurrences = `document.body.innerText.split(${JSON.stringify(finalText)}).length-1`;
async function capture(name) {
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
async function movePointerTo(node) {
  const point = await evaluate(`(() => {const rect=${node}.getBoundingClientRect();return {x:Math.round(rect.left+Math.min(48,rect.width/2)),y:Math.round(rect.top+rect.height/2)};})()`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  await pause(40);
  return point;
}
async function mouseClick(node) {
  const point = await movePointerTo(node);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
}
function pressKey(keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  // Electron separates the character phase from keyDown; native <button>
  // activation on Enter requires the same character event a keyboard emits.
  if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
}
async function hoverOver(node, label, checkDelay = false) {
  assert.equal(await evaluate(`${node}.hasAttribute('title')`), false, `${label} must not retain a native title tooltip`);
  const kind = await evaluate(`${node}.getAttribute('data-conversation-hover')`);
  const expanded = await evaluate(`${node}.getAttribute('aria-expanded')`);
  assert.ok(["read", "operation", "tool", "approval", "source"].includes(kind));
  const matchingCard = `document.querySelector('[data-slot=hover-card-content][data-conversation-hover-content="${kind}"]:not([data-closed])')`;
  const enteredAt = Date.now();
  await movePointerTo(node);
  if (checkDelay) {
    // movePointerTo includes 40ms; this samples around 500ms after entry.
    await pause(460);
    assert.equal(await evaluate(`${matchingCard}===null`), true, `${label} must stay absent after half a second`);
    checks.push(`${label} stays absent during a brief half-second hover`);
    await waitFor(`${matchingCard}!==null`, `${label} appears after sustained hover`, 4000);
    const openingMs = Date.now() - enteredAt;
    assert.ok(openingMs >= 850, `${label} opened too quickly: ${openingMs}ms`);
    hoverTimings.push({ label, openingMs });
  }
  await waitFor(`(() => {const card=${hoverCard};return card!==null && card.getBoundingClientRect().width>0 && card.getAttribute('data-conversation-hover-content')===${JSON.stringify(kind)} && !card.hasAttribute('data-starting-style') && !card.hasAttribute('data-ending-style') && Number(getComputedStyle(card).opacity)>=0.99;})()`, label);
  assert.equal(await evaluate(`${node}.getAttribute('aria-expanded')`), expanded, `${label} must preserve click expansion state`);
  assert.ok(await evaluate(`(() => {const card=${hoverCard};return document.body.contains(card) && !card.closest('.conversation') && !card.closest('.conversation-read-group-list,.conversation-operation-group-list');})()`));
}
async function leaveHover(label) {
  win.webContents.sendInputEvent({ type: "mouseMove", x: 8, y: 8 });
  await waitFor(`${hoverCard}===null`, label);
}
async function assertHoverFits(label) {
  assert.ok(await evaluate(`(() => {const card=${hoverCard}, rect=card.getBoundingClientRect();return rect.left>=-1 && rect.top>=-1 && rect.right<=innerWidth+1 && rect.bottom<=innerHeight+1 && card.scrollWidth<=card.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1;})()`), label);
  checks.push(label);
}
async function focusConversationItem(node, label, atTop = true) {
  // Expanding nested output changes a virtual row's measured height. Let its
  // ResizeObserver finish, then position the marker again before taking a PNG.
  const visible = `(() => {const viewport=document.querySelector('.conversation').getBoundingClientRect();const item=${node}.getBoundingClientRect();return item.top>=viewport.top+4 && ${atTop ? "item.top<=viewport.top+40" : "item.bottom<=viewport.bottom-4"};})()`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluate(`(() => {const viewport=document.querySelector('.conversation');viewport.scrollTop+=${node}.getBoundingClientRect().top-viewport.getBoundingClientRect().top-12;})()`);
    await pause(80);
    if (await evaluate(visible)) {
      await pause(120);
      if (await evaluate(visible)) return;
    }
  }
  throw new Error(`${label} did not settle in the screenshot viewport`);
}
const focusReadGroup = index => focusConversationItem(readMarker(index), `Read marker ${index + 1}`);
const focusTerminal = callId => focusConversationItem(toolTrigger(callId), `Terminal ${callId}`);
const markerArrowGeometry = node => `(() => {
  const marker=${node}, content=marker.querySelector('[data-slot=marker-content]');
  const arrow=marker.querySelector('.conversation-read-marker-chevron,.conversation-operation-marker-chevron');
  const last=[...content.children].findLast(child=>child.textContent.trim());
  const text=document.createRange();text.selectNodeContents(last);
  const contentRect=content.getBoundingClientRect(), lastRect=last.getBoundingClientRect(), row=marker.getBoundingClientRect();
  const lineHeight=parseFloat(getComputedStyle(last).lineHeight);
  // Use the visible text edge, rather than a stretched flex container's edge.
  // A wrapped read preview occupies a second line, so its content block is the
  // alignment edge; clipped text ends at the span's ellipsis boundary.
  const wrapped=contentRect.height>lineHeight*1.7;
  const textRight=wrapped ? contentRect.right : Math.min(text.getBoundingClientRect().right,lastRect.right,contentRect.right);
  return {gap:arrow.getBoundingClientRect().left-textRight,wrapped,width:row.width,
    fits:row.left>=marker.parentElement.getBoundingClientRect().left-1 && row.right<=marker.parentElement.getBoundingClientRect().right+1};
})()`;
async function assertMarkerArrow(node, label) {
  // Let the chevron finish its expansion rotation before measuring its box.
  await pause(180);
  const geometry = await evaluate(markerArrowGeometry(node));
  assert.ok(geometry.gap >= 4 && geometry.gap <= 12 && geometry.fits, `${label}: ${JSON.stringify(geometry)}`);
  checks.push(label);
}
async function focusOperationItem(node, label) {
  // Operation groups cap their own height, so position their inner scrollbar
  // before asking the outer virtual conversation to reveal the trigger.
  await evaluate(`(() => {const item=${node}, list=item.closest('.conversation-operation-group-list');list.scrollTop+=item.getBoundingClientRect().top-list.getBoundingClientRect().top-12;})()`);
  await pause(120);
  await focusConversationItem(node, label, false);
  await waitFor(`(() => {const item=${node}.getBoundingClientRect(), list=${node}.closest('.conversation-operation-group-list').getBoundingClientRect();return item.top>=list.top && item.bottom<=list.bottom;})()`, `${label} is visible inside its operation panel`);
}
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 920, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  // A hidden offscreen BrowserWindow never owns OS focus. Chromium's focus
  // emulation permits native Tab/Escape/Enter handling without showing a window
  // or replacing focus/mouse behavior with synthetic DOM events.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "production renderer ready");
  await click(`[...document.querySelectorAll('.history-session')].find(el=>el.querySelector('.history-session-content')?.textContent===${JSON.stringify(session.title)})`);
  await waitFor(`document.querySelector('[data-slot=trace]') && document.body.innerText.includes(${JSON.stringify(requestText)}) && document.body.innerText.includes(${JSON.stringify(finalText)})`, "completed conversation loaded");
  assert.equal(await evaluate("document.querySelectorAll('.user-message').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.prompt-textarea').length"), 1);
  assert.equal(await evaluate(finalOccurrences), 1);
  for (const id of ["call-version", "call-install"]) {
    assert.equal(await evaluate(`${toolTrigger(id)}.getAttribute('aria-expanded')`), "false");
    assert.ok(await evaluate(`${tool(id)}.querySelector('[data-slot=trace-line]')!==null`));
    assert.ok(await evaluate(`(() => { const node=${toolTrigger(id)}; return node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden'; })()`));
  }
  assert.ok(await evaluate(`${tool("call-search")}===null`));
  checks.push("completed tool summaries remain directly visible with details collapsed and merged runs leave no duplicate row");
  await waitFor("document.querySelectorAll('[data-read-tool-group]').length===2", "consecutive file reads form two marker groups");
  for (const index of [0, 1]) {
    assert.equal(await evaluate(`${readMarker(index)}.getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`${readGroup(index)}.querySelectorAll('[data-tool-call-id]').length`), 0);
  }
  assert.ok(await evaluate(`/已读取.*2.*个文件/.test(${readMarker(0)}.textContent) && /3.*次读取/.test(${readMarker(0)}.textContent)`));
  assert.ok(await evaluate(`${readMarker(0)}.textContent.includes('package.json') && ${readMarker(0)}.textContent.includes('renderer.tsx')`));
  checks.push("collapsed read marker counts unique files and previews names without mounting child calls");
  assert.equal(await evaluate(`${readGroup(1)}.getAttribute('data-read-tool-group-state')`), "error");
  assert.ok(await evaluate(`/1.*项失败/.test(${readMarker(1)}.textContent)`));
  assert.ok(await evaluate(`(() => {
    const marker=${readMarker(1)};
    return [marker,...marker.querySelectorAll('*')].some(node=>{
      const color=getComputedStyle(node).color.match(/[0-9.]+/g)?.map(Number);
      return /失败/.test(node.textContent) && node.getClientRects().length>0 && color && color[0]>color[1]*1.2 && color[0]>color[2]*1.2;
    });
  })()`));
  checks.push("collapsed failed read marker exposes its failure count in red");
  for (const id of singletonReadIds) {
    assert.ok(await evaluate(`${tool(id)}!==null && ${tool(id)}.closest('[data-read-tool-group]')===null`));
  }
  assert.ok(await evaluate(`(() => {
    const before=${tool("call-read-before-human")}, after=${tool("call-read-after-human")};
    const human=[...document.querySelectorAll('.user-message')].find(node=>node.innerText===${JSON.stringify(steeringText)});
    return Boolean(before.compareDocumentPosition(human)&Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(human.compareDocumentPosition(after)&Node.DOCUMENT_POSITION_FOLLOWING);
  })()`));
  checks.push("terminal, narration and human reply boundaries keep singleton reads separate");
  for (const index of [0, 1]) await assertMarkerArrow(readMarker(index), `desktop collapsed read marker ${index + 1} keeps its arrow beside visible text`);

  await focusReadGroup(0);
  await capture("marker-collapsed.png");
  await movePointerTo(readMarker(0));
  await pause(310);
  assert.equal(await evaluate("document.querySelector('[data-slot=hover-card-content]')===null"), true);
  checks.push("passing over a read marker for 350ms never mounts a hover card");
  win.webContents.sendInputEvent({ type: "mouseMove", x: 8, y: 8 });
  await pause(1100);
  assert.equal(await evaluate("document.querySelector('[data-slot=hover-card-content]')===null"), true);
  checks.push("leaving a brief hover cancels its pending preview beyond the one-second delay");
  await hoverOver(readMarker(0), "read marker opens a shadcn hover card from real pointer input", true);
  assert.ok(await evaluate(`${hoverCard}.textContent.includes('package.json') && ${hoverCard}.textContent.includes('apps/desktop/src/renderer.tsx')`));
  await assertHoverFits("read hover card escapes the conversation clip and fits inside the desktop viewport");
  await capture("hover-read.png");
  await movePointerTo(hoverCard);
  await pause(450);
  assert.ok(await evaluate(`${hoverCard}!==null && ${hoverCard}.textContent.includes('apps/desktop/src/renderer.tsx')`));
  checks.push("moving the pointer from a read trigger into its hover card keeps the file details available");
  await hoverOver(toolTrigger("call-install"), "switching from an open read card to a command card", true);
  await leaveHover("leaving the read trigger and hover card dismisses the preview");
  await hoverOver(readMarker(0), "the read hover card can reopen after pointer dismissal");
  await mouseClick(readMarker(0));
  await waitFor(`${readMarker(0)}.getAttribute('aria-expanded')==='true' && ${readGroup(0)}.querySelectorAll('[data-tool-call-id]').length===3`, "read marker expands into its three original calls");
  await leaveHover("clicking a hover-enabled read marker preserves expansion and its card can dismiss");
  assert.deepEqual(await evaluate(`[...${readGroup(0)}.querySelectorAll('[data-tool-call-id]')].map(node=>node.getAttribute('data-tool-call-id'))`), successReadIds);
  for (const id of successReadIds) assert.equal(await evaluate(`${toolTrigger(id)}.getAttribute('aria-expanded')`), "false");
  await assertMarkerArrow(readMarker(0), "desktop expanded read marker keeps its arrow beside visible text");
  await focusReadGroup(0);
  await capture("marker-expanded.png");
  await click(toolTrigger("call-read-renderer"));
  await waitFor(`${tool("call-read-renderer")}.textContent.includes('"startLine": 1') && ${tool("call-read-renderer")}.textContent.includes('"endLine": 40') && ${tool("call-read-renderer")}.textContent.includes('export const fixtureRenderer = true;')`, "nested range read exposes its real line parameters and output");
  await waitFor(`(() => {const detail=${tool("call-read-renderer")}.querySelector('.conversation-trace-tool-detail');return detail.getBoundingClientRect().bottom<=${readGroup(0)}.getBoundingClientRect().bottom+1;})()`, "expanded read output is fully revealed by the marker panel");
  await focusReadGroup(0);
  await capture("marker-output-expanded.png");
  await click(toolTrigger("call-read-renderer"));
  await click(readMarker(0));
  await focusConversationItem(readMarker(1), "Keyboard read preview trigger", false);
  pressKey("Tab");
  await evaluate(`${readMarker(1)}.focus()`);
  await waitFor(`${hoverCard}!==null && ${hoverCard}.getAttribute('data-conversation-hover-content')==='read'`, "keyboard focus opens the read hover card");
  assert.equal(await evaluate(`${readMarker(1)}.getAttribute('aria-expanded')`), "false");
  pressKey("Escape");
  await waitFor(`${hoverCard}===null`, "Escape dismisses a keyboard-focused hover card without expanding its read group");
  pressKey("Enter");
  await waitFor(`${readGroup(1)}.querySelectorAll('[data-tool-call-id]').length===2`, "failed read marker expands into both original calls");
  checks.push("Enter retains the read marker's expansion action after dismissing its keyboard preview");
  await evaluate(`${readMarker(1)}.blur()`);
  await leaveHover("blurring the keyboard read trigger clears any remaining preview");
  assert.deepEqual(await evaluate(`[...${readGroup(1)}.querySelectorAll('[data-tool-call-id]')].map(node=>node.getAttribute('data-tool-call-id'))`), failedReadIds);
  await assertMarkerArrow(readMarker(1), "desktop expanded failed read marker keeps its arrow beside visible text");
  await click(toolTrigger("call-read-missing"));
  await waitFor(`${tool("call-read-missing")}.innerText.includes(${JSON.stringify(failedReadOutput)})`, "nested failed read keeps its actionable error output");
  await waitFor(`(() => {const detail=${tool("call-read-missing")}.querySelector('.conversation-trace-tool-detail');return detail.getBoundingClientRect().bottom<=${readGroup(1)}.getBoundingClientRect().bottom+1;})()`, "failed read output is fully revealed by the marker panel");
  await focusReadGroup(1);
  await capture("marker-failed-expanded.png");
  await click(toolTrigger("call-read-missing"));
  await click(readMarker(1));
  await waitFor("document.querySelectorAll('[data-conversation-process-message]').length===2", "completed conversation retains both process messages");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-conversation-process-message]')].map(node=>node.getAttribute('data-streaming'))"), ["false", "false"]);
  assert.ok(await evaluate(`(() => {
    const messages=[...document.querySelectorAll('[data-conversation-process-message]')];
    return messages.every((node,index)=>node.innerText.includes(${JSON.stringify(processMarkers)}[index]) && node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden' && !node.querySelector('[data-slot=trace-collapsible-trigger]'));
  })()`));
  assert.ok(await evaluate("[...document.querySelectorAll('[data-conversation-process-message]')].every(node=>node.querySelectorAll('.md-content p').length===2 && node.querySelector('.md-content strong') && node.querySelector('.md-content code'))"));
  checks.push("process messages remain visible as multi-paragraph Markdown without an expansion action");
  assert.ok(await evaluate(`(() => {
    const messages=[...document.querySelectorAll('[data-conversation-process-message]')];
    const version=${tool("call-version")}, install=${tool("call-install")};
    return Boolean(messages[0].compareDocumentPosition(version)&Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(version.compareDocumentPosition(messages[1])&Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(messages[1].compareDocumentPosition(install)&Node.DOCUMENT_POSITION_FOLLOWING);
  })()`));
  checks.push("process narration stays before and between its corresponding tool calls");
  assert.ok(await evaluate(`!${JSON.stringify(processMarkers)}.some(text=>document.querySelector('.conversation-final-stream').innerText.includes(text))`));
  checks.push("final answer is separate from the process narration");
  const reasoningTrigger = "document.querySelector('[data-conversation-reasoning=true] [data-slot=trace-collapsible-trigger]')";
  assert.ok(await evaluate(`${reasoningTrigger}!==null`));
  assert.equal(await evaluate(`${reasoningTrigger}.getAttribute('aria-expanded')`), "false");
  await click(reasoningTrigger);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(reasoningText)})`, "reasoning summary expands to the recorded text");
  await click(reasoningTrigger);
  const terminalStyles = await evaluate(`['call-version','call-install'].map(id=>{
    const rgb=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3);};
    const root=document.querySelector('[data-tool-call-id="'+id+'"]');
    const trigger=root.querySelector('.conversation-terminal-trigger');
    const command=root.querySelector('.conversation-terminal-command');
    const arrow=trigger.querySelector('.ui-trace-chevron');
    const icon=root.querySelector('.conversation-terminal-status-icon');
    const commandStyle=getComputedStyle(command), triggerStyle=getComputedStyle(trigger), rootStyle=getComputedStyle(root);
    return {terminal:root.getAttribute('data-conversation-terminal'),state:root.getAttribute('data-tool-state'),text:command.textContent,
      commandColor:commandStyle.color,arrowColor:getComputedStyle(arrow).color,commandRgb:rgb(commandStyle.color),iconRgb:rgb(getComputedStyle(icon).color),
      whiteSpace:commandStyle.whiteSpace,height:command.getBoundingClientRect().height,lineHeight:parseFloat(commandStyle.lineHeight),
      rootBackground:rootStyle.backgroundColor,triggerBackground:triggerStyle.backgroundColor,
      grouped:root.closest('[data-read-tool-group]')!==null,summaryDuration:trigger.querySelector('[data-slot=trace-description]')!==null,
      arrowVisible:arrow.getClientRects().length>0 && getComputedStyle(arrow).visibility!=='hidden',
      iconVisible:icon.getClientRects().length>0 && getComputedStyle(icon).visibility!=='hidden'};
  })`);
  assert.deepEqual(terminalStyles.map(item => item.state), ["completed", "error"]);
  assert.ok(terminalStyles.every(item => item.terminal === "true" && !item.grouped && item.arrowVisible && item.iconVisible));
  assert.ok(terminalStyles[0].text.endsWith("pnpm --version"));
  assert.ok(!terminalStyles[1].text.includes("\n") && terminalStyles[1].text.endsWith(longCommand.replace(/\s+/g, " ").trim()));
  const gray = terminalStyles[0].commandColor;
  assert.ok(terminalStyles.every(item => item.commandColor === gray && item.arrowColor === gray));
  const grayChannels = terminalStyles[0].commandRgb;
  assert.ok(grayChannels && grayChannels[0] >= 100 && grayChannels[0] <= 220 && Math.max(...grayChannels.slice(0, 3)) - Math.min(...grayChannels.slice(0, 3)) <= 10);
  const errorChannels = terminalStyles[1].iconRgb;
  assert.ok(errorChannels && errorChannels[0] > errorChannels[1] * 1.2 && errorChannels[0] > errorChannels[2] * 1.2);
  checks.push("terminal commands and arrows share light gray text while only the failure icon is red");
  assert.ok(terminalStyles.every(item => item.whiteSpace === "nowrap" && item.height <= item.lineHeight + 1 && !item.summaryDuration));
  assert.ok(terminalStyles.every(item => item.rootBackground === "rgba(0, 0, 0, 0)" && item.triggerBackground === "rgba(0, 0, 0, 0)"));
  assert.ok(await evaluate(`(() => {
    const root=${tool("call-version")}, command=root.querySelector('.conversation-terminal-command'), arrow=root.querySelector('.ui-trace-chevron');
    const text=document.createRange();text.selectNodeContents(command);const gap=arrow.getBoundingClientRect().left-text.getBoundingClientRect().right;
    return gap>=-1 && gap<=20;
  })()`));
  checks.push("each terminal call stays on one unboxed line with its arrow beside the command and timing in details");
  await focusTerminal("call-version");
  await capture("terminal-collapsed.png");
  await focusConversationItem(toolTrigger("call-install"), "Command hover trigger", false);
  await hoverOver(toolTrigger("call-install"), "a real pointer opens the failed command hover card");
  assert.ok(await evaluate(`(() => {const text=${hoverCard}.textContent;return text.replace(/\\s+/g,' ').includes(${JSON.stringify(longCommand.replace(/\s+/g, " ").trim())}) && text.includes('terminal') && /1[.,]5\\s*秒|1542\\s*ms/.test(text) && !text.includes(${JSON.stringify(failureOutput)});})()`));
  await assertHoverFits("the full multiline command fits in a desktop hover card without displaying execution output");
  await capture("hover-command.png");
  pressKey("Escape");
  await waitFor(`${hoverCard}===null`, "Escape dismisses the command hover card");
  await leaveHover("the dismissed command preview stays closed after the pointer leaves");

  await click(toolTrigger("call-install"));
  await waitFor(`${toolTrigger("call-install")}.getAttribute('aria-expanded')==='true' && ${tool("call-install")}.textContent.includes(${JSON.stringify(JSON.stringify(longCommand))}) && ${tool("call-install")}.innerText.includes(${JSON.stringify(failureOutput)}) && ${tool("call-install")}.textContent.includes('stdout') && ${tool("call-install")}.textContent.includes('stderr') && /1[.,]5.*秒|1542.*ms|1[.,]5.*s/.test(${tool("call-install")}.innerText)`, "command details expose the complete original multiline input, timing, stdout and stderr");
  await focusTerminal("call-install");
  await capture("terminal-expanded.png");
  await click(toolTrigger("call-version"));
  await waitFor(`${tool("call-version")}.innerText.includes(${JSON.stringify(successOutput)}) && ${tool("call-version")}.textContent.includes('pnpm --version') && ${tool("call-version")}.textContent.includes('stdout') && ${tool("call-version")}.textContent.includes('stderr') && ${tool("call-version")}.innerText.includes('95 ms')`, "successful command keeps its full input, timing, stdout and stderr inspectable");
  await click(toolTrigger("call-version"));
  await click(toolTrigger("call-install"));

  const operationGroup = "document.querySelector('[data-operation-group]')";
  const operationMarker = `${operationGroup}.querySelector('button[data-slot=marker]')`;
  const operationRows = `${operationGroup}.querySelectorAll('[data-tool-call-id],[data-conversation-approval]')`;
  await waitFor(`${operationGroup}!==null`, "an approval-gated run collapses into one operation row");
  assert.equal(await evaluate("document.querySelectorAll('[data-operation-group]').length"), 1);
  assert.equal(await evaluate(`${operationMarker}.getAttribute('aria-expanded')`), "false");
  assert.ok(await evaluate(`${operationMarker}.textContent.includes('运行了命令')`));
  assert.equal(await evaluate(`${operationRows}.length`), 0);
  assert.equal(await evaluate("document.body.innerText.includes('PROBE_STDIN_BEGIN')"), false);
  assert.ok(await evaluate(`(() => {
    const marker=${operationMarker}, label=marker.querySelector('.conversation-operation-marker-label'), style=getComputedStyle(label), group=${operationGroup}.getBoundingClientRect(), row=marker.getBoundingClientRect();
    return style.whiteSpace==='nowrap' && label.getBoundingClientRect().height<=parseFloat(style.lineHeight)+1 && row.left>=group.left-1 && row.right<=group.right+1;
  })()`));
  assert.ok(await evaluate(`${operationMarker}.querySelectorAll('.ui-trace-chevron,.conversation-operation-marker-chevron').length===1 && ${operationMarker}.querySelector('.conversation-operation-marker-chevron').getClientRects().length>0`));
  checks.push("a gated run collapses to one line and keeps its raw command payload out of the rendered transcript");
  await assertMarkerArrow(operationMarker, "desktop collapsed operation marker keeps its arrow beside its short label");
  await focusConversationItem(operationMarker, "Operation hover trigger", false);
  await hoverOver(operationMarker, "the operation summary opens its hover card without expanding the group");
  assert.equal(await evaluate(`${operationMarker}.getAttribute('aria-expanded')`), "false");
  assert.ok(await evaluate(`${hoverCard}.textContent.includes('运行了命令') && /3.*项操作/.test(${hoverCard}.textContent) && /2.*条审批请求/.test(${hoverCard}.textContent) && !${hoverCard}.textContent.includes('PROBE_STDIN')`));
  await leaveHover("the operation hover card closes without changing its collapsed state");
  // Negative control: restoring the former full-width flex layout must recreate
  // the visible gap. This guards against measuring a stretched content box.
  await evaluate(`(() => { const style=document.createElement('style');style.id='marker-arrow-negative-control';style.textContent='.conversation-operation-marker{width:100%}.conversation-operation-marker .ui-marker-content{flex:1 1 auto}.conversation-operation-marker-chevron{margin-left:auto}';document.head.append(style); })()`);
  const previousArrowGeometry = await evaluate(markerArrowGeometry(operationMarker));
  await evaluate("document.getElementById('marker-arrow-negative-control').remove()");
  assert.ok(previousArrowGeometry.gap > 40, `former marker layout should fail the arrow spacing check: ${JSON.stringify(previousArrowGeometry)}`);
  checks.push("arrow geometry rejects the former full-width layout with its far-right chevron");
  await focusReadGroup(0);
  await capture("arrows-desktop.png");
  // The merged row sits near the end of the turn, where nothing can scroll it to the viewport top.
  await focusConversationItem(operationMarker, "Operation row", false);
  await capture("operation-collapsed.png");
  await click(operationMarker);
  await waitFor(`${operationRows}.length===5`, "the operation row expands into its approval and call rows");
  await assertMarkerArrow(operationMarker, "desktop expanded operation marker keeps its arrow beside its short label");
  assert.deepEqual(await evaluate(`[...${operationRows}].map(node=>node.getAttribute('data-tool-call-id')??node.getAttribute('data-conversation-approval'))`),
    ["call-search", "approval-probe-fail", "call-probe-fail", "approval-probe-ok", "call-probe-ok"]);
  const probeStyles = await evaluate(`${JSON.stringify(probeFixtures.map(probe => probe.callId))}.map(id=>{
    const rgb=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3);};
    const root=document.querySelector('[data-tool-call-id="'+id+'"]');
    const trigger=root.querySelector('[data-slot=trace-collapsible-trigger]'), title=trigger.querySelector('[data-slot=trace-title]'), arrow=trigger.querySelector('.ui-trace-chevron'), icon=root.querySelector('.conversation-terminal-status-icon');
    const style=getComputedStyle(title);
    return {name:root.getAttribute('data-tool-name'),terminal:root.getAttribute('data-conversation-terminal'),state:root.getAttribute('data-tool-state'),expanded:trigger.getAttribute('aria-expanded'),text:title.textContent,
      commandColor:style.color,arrowColor:getComputedStyle(arrow).color,iconRgb:rgb(getComputedStyle(icon).color),whiteSpace:style.whiteSpace,height:title.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),
      arrowVisible:arrow.getClientRects().length>0,iconVisible:icon.getClientRects().length>0,summaryDuration:trigger.querySelector('[data-slot=trace-description]')!==null,
      inputMounted:root.querySelector('[data-slot=code-block]')!==null};
  })`);
  assert.deepEqual(probeStyles.map(row => row.state), ["error", "completed"]);
  assert.deepEqual(probeStyles.map(row => row.text), ["执行失败 probe · python -", "已运行 probe · python3 -"]);
  assert.ok(probeStyles.every(row => row.name === "probe" && row.terminal === "true" && row.expanded === "false" && row.arrowVisible && row.iconVisible && !row.summaryDuration && !row.inputMounted));
  assert.ok(probeStyles.every(row => row.commandColor === gray && row.arrowColor === gray && row.whiteSpace === "nowrap" && row.height <= row.lineHeight + 1));
  assert.ok(probeStyles[0].iconRgb[0] > probeStyles[0].iconRgb[1] * 1.2 && probeStyles[0].iconRgb[0] > probeStyles[0].iconRgb[2] * 1.2);
  assert.ok(probeStyles.every(row => !row.text.includes("PROBE_STDIN") && !/ms|毫秒|秒/.test(row.text)));
  checks.push("probe displays its real command on the same gray single line as terminal, with a red failure icon and hidden stdin/timing");
  for (const probe of probeFixtures) {
    assert.equal(await evaluate(`${approvalTrigger(probe.approvalId)}.getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`${approval(probe.approvalId)}.getAttribute('data-approval-risk')`), "high");
    assert.ok(await evaluate(`(() => {
      const row=${approval(probe.approvalId)}, trigger=row.querySelector('[data-slot=trace-collapsible-trigger]'), label=trigger.querySelector('[data-slot=trace-title]'), arrow=trigger.querySelector('.ui-trace-chevron'), style=getComputedStyle(label);
      return label.textContent===${JSON.stringify(`审批请求 probe · ${probe.command}`)} && trigger.innerText.includes('高风险') && !/已批准|审批通过|已授权|PROBE_STDIN|records.append/.test(trigger.textContent) && style.color===${JSON.stringify(gray)} && getComputedStyle(arrow).color===${JSON.stringify(gray)} && style.whiteSpace==='nowrap' && label.getBoundingClientRect().height<=parseFloat(style.lineHeight)+1 && !row.querySelector('[data-slot=code-block]');
    })()`));
  }
  checks.push("complete and truncated probe approval records use compact gray request titles, retain risk, and make no approval-success claim");
  await focusOperationItem(approvalTrigger("approval-probe-fail"), "Approval hover trigger");
  await hoverOver(approvalTrigger("approval-probe-fail"), "the probe approval summary opens a compact hover card");
  assert.ok(await evaluate(`(() => {const text=${hoverCard}.textContent;return text.includes('probe') && text.includes('python -') && text.includes('高风险') && !/已批准|审批通过|已授权|PROBE_STDIN|records.append/.test(text);})()`));
  await hoverOver(toolTrigger("call-probe-ok"), "switching from an open approval card to a probe command card", true);
  await leaveHover("leaving the approval hover card keeps its recorded details collapsed");
  await focusOperationItem(toolTrigger("call-probe-fail"), "Probe hover trigger");
  await hoverOver(toolTrigger("call-probe-fail"), "the probe command uses the same hover card as terminal");
  assert.ok(await evaluate(`(() => {const text=${hoverCard}.textContent;return text.includes('probe') && text.includes('python -') && text.includes('201 ms') && !text.includes('PROBE_STDIN') && !text.includes(${JSON.stringify(probeFailureOutput)});})()`));
  await leaveHover("probe hover dismissal preserves the collapsed command details");
  await focusOperationItem(approvalTrigger("approval-probe-fail"), "Probe command rows");
  await capture("probe-collapsed.png");
  await capture("operation-expanded.png");
  for (const probe of probeFixtures) {
    await click(approvalTrigger(probe.approvalId));
    await waitFor(`${approval(probe.approvalId)}.querySelector('[data-slot=code-block-code]')?.textContent===${JSON.stringify(probe.approvalSummary)}`, `${probe.approvalId} retains its exact recorded approval payload`);
    assert.equal(await evaluate(`${approvalTrigger(probe.approvalId)}.textContent.includes('PROBE_STDIN')`), false);
    if (probe.approvalId === "approval-probe-fail") {
      await focusOperationItem(approvalTrigger(probe.approvalId), "Expanded approval request");
      await capture("approval-expanded.png");
    } else {
      assert.equal(await evaluate(`${approval(probe.approvalId)}.textContent.includes('PROBE_STDIN_END')`), false);
    }
    await click(approvalTrigger(probe.approvalId));
  }
  for (const probe of probeFixtures) {
    await click(toolTrigger(probe.callId));
    await waitFor(`(() => { const row=${tool(probe.callId)}, codes=[...row.querySelectorAll('[data-slot=code-block-code]')].map(node=>node.textContent);return codes.includes(${JSON.stringify(probe.command)}) && codes.includes(${JSON.stringify(JSON.stringify({ command: probe.command, stdin: probe.stdin }, null, 2))}) && row.textContent.includes(${JSON.stringify(probe.output)}) && row.textContent.includes('evidenceId') && row.textContent.includes('result') && row.innerText.includes(${JSON.stringify(`${probe.isError ? 201 : 108} ms`)}); })()`, `${probe.callId} exposes its full command, stdin, real result envelope and timing`);
    assert.equal(await evaluate(`${toolTrigger(probe.callId)}.textContent.includes('PROBE_STDIN')`), false);
    if (probe.isError) {
      await focusOperationItem(toolTrigger(probe.callId), "Expanded failed probe");
      await capture("probe-expanded.png");
    }
    await click(toolTrigger(probe.callId));
  }
  checks.push("probe and approval details preserve recorded payloads without pushing raw stdin into their collapsed headers");
  await click(operationMarker);
  await waitFor(`${operationMarker}.getAttribute('aria-expanded')==='false' && ${operationRows}.length===0`, "the operation row collapses back to one line");
  checks.push("every approval and call keeps its own expandable row inside the merged operation row");

  await waitFor(`${sources} && ${sources}.innerText.includes('2')`, "source summary counts unique safe URLs");
  assert.equal(await evaluate(`${sources}.querySelector('[data-slot=trace-collapsible-trigger]').getAttribute('aria-expanded')`), "false");
  await click(`${sources}.querySelector('[data-slot=trace-collapsible-trigger]')`);
  await waitFor(`${sources}.querySelectorAll('a[href]').length===2`, "source details show the unique result links");
  assert.deepEqual(await evaluate(`[...${sources}.querySelectorAll('a[href]')].map(link=>link.href).sort()`), [...sourceUrls].sort());
  assert.equal(await evaluate("document.querySelectorAll('a[href^=\"javascript:\"]').length"), 0);
  const firstSource = `${sources}.querySelector('a[href]')`;
  await focusConversationItem(firstSource, "Source hover trigger", false);
  await hoverOver(firstSource, "source links display their complete URL in a hover card");
  assert.ok(await evaluate(`${hoverCard}.textContent.includes(${JSON.stringify(sourceUrls[0])})`));
  await leaveHover("leaving the source preview keeps its link available for opening");
  await click(`${sources}.querySelector('a[href]')`);
  const linkDeadline = Date.now() + 3000;
  while (openedUrls.length === 0 && Date.now() < linkDeadline) await pause(20);
  assert.equal(openedUrls.length, 1);
  assert.equal(await evaluate("window.__traceUnsafeExecuted===true"), false);
  checks.push("source links use openExternal and unsafe URLs are never executable");
  await click(`${sources}.querySelector('[data-slot=trace-collapsible-trigger]')`);
  await evaluate("document.querySelector('[data-slot=trace]').scrollIntoView({block:'center'})");
  await capture("trace-desktop.png");

  win.setSize(760, 920);
  await pause(100);
  await waitFor("(() => { const traces=[...document.querySelectorAll('[data-slot=trace]')]; return traces.length>0 && traces.every(trace=>{const rect=trace.getBoundingClientRect(); return rect.width>0 && trace.scrollWidth<=trace.clientWidth+1 && [...trace.querySelectorAll('[data-slot=trace-line],button[data-slot=marker]')].every(line=>line.getBoundingClientRect().right<=rect.right+1);}) && document.documentElement.scrollWidth<=innerWidth+1; })()", "long commands and read markers fit the narrow conversation without horizontal page overflow");
  await capture("trace-narrow.png");
  for (const index of [0, 1]) await assertMarkerArrow(readMarker(index), `narrow collapsed read marker ${index + 1} keeps its arrow beside visible content`);
  await assertMarkerArrow(operationMarker, "narrow collapsed operation marker keeps its arrow beside its short label");
  assert.ok(await evaluate(`(() => {const preview=${readMarker(0)}.querySelector('.conversation-read-marker-preview'), style=getComputedStyle(preview);return style.textOverflow==='ellipsis' && style.overflowX==='hidden' && preview.scrollWidth>preview.clientWidth && document.documentElement.scrollWidth<=innerWidth+1;})()`));
  checks.push("long file previews truncate with an ellipsis without horizontal page overflow");
  await focusReadGroup(0);
  await capture("arrows-narrow.png");
  await hoverOver(readMarker(0), "read hover details remain available beside a truncated narrow preview");
  assert.ok(await evaluate(`${hoverCard}.textContent.includes('apps/desktop/src/renderer.tsx')`));
  await assertHoverFits("the read hover card stays inside the narrow viewport without clipping or horizontal overflow");
  await capture("hover-narrow.png");
  await leaveHover("the narrow read hover card dismisses after the pointer leaves");
  for (const index of [0, 1]) {
    await click(readMarker(index));
    await waitFor(`${readMarker(index)}.getAttribute('aria-expanded')==='true'`, `read marker ${index + 1} opens at narrow width`);
    await assertMarkerArrow(readMarker(index), `narrow expanded read marker ${index + 1} keeps its arrow beside visible content`);
    await click(readMarker(index));
  }
  await focusTerminal("call-version");
  await capture("terminal-narrow.png");
  await click(operationMarker);
  await waitFor(`${operationRows}.length===5`, "probe and approval rows remain available at narrow width");
  await assertMarkerArrow(operationMarker, "narrow expanded operation marker keeps its arrow beside its short label");
  assert.ok(await evaluate(`(() => {
    const viewport=document.querySelector('.conversation').getBoundingClientRect();
    const nodes=[${toolTrigger("call-probe-fail")},${toolTrigger("call-probe-ok")},${approvalTrigger("approval-probe-fail")},${approvalTrigger("approval-probe-ok")}];
    return nodes.every(node=>{const row=node.getBoundingClientRect(), title=node.querySelector('[data-slot=trace-title]'), style=getComputedStyle(title);return row.right<=viewport.right+1 && title.getBoundingClientRect().height<=parseFloat(style.lineHeight)+1 && style.whiteSpace==='nowrap';}) && document.documentElement.scrollWidth<=innerWidth+1;
  })()`));
  await focusOperationItem(approvalTrigger("approval-probe-fail"), "Narrow probe rows");
  await capture("probe-narrow.png");
  await click(operationMarker);
  checks.push("probe command and approval rows keep a single line without horizontal overflow at narrow width");

  const recordSnapshot = `({
    user: [...document.querySelectorAll('.user-message')].map(node=>node.innerText),
    toolIds: [...document.querySelectorAll('[data-tool-call-id]')].map(node=>node.getAttribute('data-tool-call-id')),
    summaries: [...document.querySelectorAll('[data-slot=trace-collapsible-trigger]')].map(node=>node.textContent),
    process: [...document.querySelectorAll('[data-conversation-process-message]')].map(node=>node.innerText),
    readMarkers: [...document.querySelectorAll('[data-read-tool-group]')].map(node=>({state:node.getAttribute('data-read-tool-group-state'),text:node.querySelector('button[data-slot=marker]').textContent})),
    final: [...document.querySelectorAll('.conversation-final-stream .md-content')].map(node=>node.textContent),
    sourceCount: document.querySelector('[data-conversation-sources=true]')?.textContent
  })`;
  const completeRecord = await evaluate(recordSnapshot);
  await waitFor("document.querySelector('.conversation-replay')", "read-only replay is offered for the completed turn");
  await click("document.querySelector('.conversation-replay')");
  await waitFor("document.querySelector('.conversation-turn[data-replay-state=playing]') && document.querySelector('.conversation-replay') && /停止|结束|Stop|Finish/i.test(document.querySelector('.conversation-replay').textContent+' '+document.querySelector('.conversation-replay').getAttribute('aria-label'))", "replay exposes a stop or finish control");
  await click("document.querySelector('.conversation-replay')");
  await waitFor(`${finalOccurrences}===1 && document.querySelector('.conversation-turn[data-replay-state=idle]') && /回放|Replay/i.test(document.querySelector('.conversation-replay')?.textContent ?? '')`, "stopping replay restores the original final answer exactly once");
  await click("document.querySelector('.conversation-replay')");
  await waitFor("document.querySelector('.conversation-turn[data-replay-state=playing]') && document.querySelector('.conversation-replay') && /停止|结束|Stop|Finish/i.test(document.querySelector('.conversation-replay').textContent+' '+document.querySelector('.conversation-replay').getAttribute('aria-label'))", "replay can be started again after stopping");
  await waitFor(`document.querySelector('.conversation-turn[data-replay-state=playing]') && document.querySelectorAll('[data-conversation-process-message]').length===2 && [...document.querySelectorAll('[data-conversation-process-message]')].every((node,index)=>node.innerText.includes(${JSON.stringify(processMarkers)}[index]))`, "recorded process messages stay visible during replay");
  await waitFor(`${finalOccurrences}===1 && document.querySelector('.conversation-turn[data-replay-state=idle]') && /回放|Replay/i.test(document.querySelector('.conversation-replay')?.textContent ?? '') && !/停止|结束|Stop|Finish/i.test(document.querySelector('.conversation-replay')?.textContent ?? '')`, "replay naturally finishes and restores the full conversation", 15000);
  assert.deepEqual(await evaluate(recordSnapshot), completeRecord);
  checks.push("replay preserves the complete user, reasoning, process, tool, source and final records");
  for (const [index, ids] of [[0, successReadIds], [1, failedReadIds]]) {
    await click(readMarker(index));
    await waitFor(`${readGroup(index)}.querySelectorAll('[data-tool-call-id]').length===${ids.length}`, `read group ${index + 1} reopens after replay`);
    assert.deepEqual(await evaluate(`[...${readGroup(index)}.querySelectorAll('[data-tool-call-id]')].map(node=>node.getAttribute('data-tool-call-id'))`), ids);
  }
  await click(toolTrigger("call-read-renderer"));
  await waitFor(`${tool("call-read-renderer")}.textContent.includes('export const fixtureRenderer = true;')`, "replay retains nested read outputs behind the markers");
  await click(toolTrigger("call-read-renderer"));
  await click(readMarker(0));
  await click(readMarker(1));
  await click(operationMarker);
  await waitFor(`${operationRows}.length===5`, "replay preserves the grouped probe and approval records");
  await click(approvalTrigger("approval-probe-ok"));
  await waitFor(`${approval("approval-probe-ok")}.querySelector('[data-slot=code-block-code]')?.textContent===${JSON.stringify(probeFixtures[1].approvalSummary)}`, "replay preserves the recorded truncated approval payload exactly");
  await click(approvalTrigger("approval-probe-ok"));
  await click(toolTrigger("call-probe-fail"));
  await waitFor(`${tool("call-probe-fail")}.textContent.includes(${JSON.stringify(probeFailureOutput)}) && ${tool("call-probe-fail")}.textContent.includes('PROBE_STDIN_END')`, "replay preserves the probe input and failure result behind expansion");
  await click(toolTrigger("call-probe-fail"));
  await click(operationMarker);
  assert.equal(requests.filter(request => request.method === "run.start" || request.method === "run.resume").length, 0);
  checks.push("replay is local and read-only without starting or resuming a run");
  assert.deepEqual(errors, []);
  return { checks, scratch, hoverTimings, openedUrls, daemonMethods: [...new Set(requests.map(request => request.method))] };
}
const timer = setTimeout(() => { console.error("Trace UI test timeout"); app.exit(1); }, 60000);
main().then(result => {
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0);
}).catch(async error => {
  console.error(error); console.error(errors);
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, errors, openedUrls, requests }, null, 2));
  if (win && !win.isDestroyed()) await capture("failure.png");
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
