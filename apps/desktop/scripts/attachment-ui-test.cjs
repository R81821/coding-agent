// Run after pnpm --filter @harness/desktop build. The production renderer uses
// isolated Electron storage and fixture IPC; no daemon, files dialog or provider.
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
const guardPath = path.join(root, "apps/desktop/src/renderer-ipc.ts");
const guardModule = new Module(guardPath, module);
guardModule._compile(ts.transpileModule(fs.readFileSync(guardPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, guardPath);
const { sanitizeRendererRequest } = guardModule.exports;
const scratch = fs.mkdtempSync(path.join(root, ".cache/attachment-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();
const at = "2026-10-16T00:00:00.000Z";
const profile = { id: "default", name: "Developer", allowedProviders: ["openai"], preferredModels: [], skillIds: [], pluginIds: [], toolNames: [], budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {}, verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture" };
const model = { providerId: "openai", modelId: "gpt-6.1-sol", displayName: "OpenAI", capabilities: { vision: true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "cloud", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }, healthy: true };
const sessions = new Map(["a", "b"].map(id => [id, { id, workspacePath: "D:/fixture-attachment-project", profileId: "default", title: `附件会话 ${id}`, createdAt: at, updatedAt: at, reasoningEffort: null }]));
const runs = new Map();
const requests = [];
let attachments;
function sessionRuns(id) { return [...runs.values()].filter(run => run.spec.sessionId === id); }
async function fixtureRequest(request) {
  requests.push(request);
  const params = request.params;
  switch (request.method) {
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "mcp.interactions.list": return { requests: [] };
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "sessions.list": return { items: [...sessions.values()].map(session => { const owned = sessionRuns(session.id); return { ...session, runCount: owned.length, ...(owned[0] ? { latestRunId: owned[0].spec.id, latestStatus: owned[0].status } : {}) }; }), hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath: "D:/fixture-attachment-project", createdAt: at, updatedAt: at }];
    case "session.view": return { session: sessions.get(params.sessionId), runs: sessionRuns(params.sessionId), hasMore: false };
    case "fixture.chooseImages": assert.deepEqual(params.allowedProviders, profile.allowedProviders); return attachments;
    case "run.start": runs.set(params.id, { spec: params, status: "paused", events: [] }); return { runId: params.id };
    case "run.eventPage": return { runId: params.runId, status: "paused", events: [], nextSequence: params.afterSequence ?? -1, hasMore: false };
    default: return [];
  }
}
ipcMain.handle("attachment-fixture", (_event, request) => {
  assert.equal(request.method, "fixture.chooseImages");
  return fixtureRequest(request);
});
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),
  chooseImages:allowedProviders=>ipcRenderer.invoke('attachment-fixture',{method:'fixture.chooseImages',params:{allowedProviders}}),
  desktopCommand:async()=>{},setTitlebarTheme:async()=>{},browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),
  onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
let win;
const checks = [];
const rendererErrors = [];
const evaluate = code => win.webContents.executeJavaScript(code).catch(error => { error.message += `\nEvaluating: ${code}`; throw error; });
async function waitFor(code, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(code)) { checks.push(label); return; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function openSession(id) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes('附件会话 ${id}')).click()`);
  await waitFor("!document.querySelector('.new-task-button').disabled", `opened session ${id}`);
}
async function screenshot(name) {
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
function assertCheck(value, label) { assert.equal(value, true, label); checks.push(label); }
const timer = setTimeout(() => { console.error("Attachment UI tests timed out"); app.exit(1); }, 90000);
async function main() {
  await app.whenReady();
  const thumbnail = nativeImage.createFromPath(path.join(root, "apps/desktop/src/assets/harness-blue-lab.png")).resize({ width: 160, height: 96 }).toDataURL();
  assert.ok(thumbnail.startsWith("data:image/png;base64,"));
  const names = ["产品界面参考.png", "没有预览但仍可发送的恢复图片.png", "包含很长很长的中文文件名称以及版本号的界面参考图片-final-2026-10-16.png", "工作区截图.png", "第二张参考图片.png", undefined];
  attachments = names.map((fileName, index) => ({
    attachment: { id: `attachment-${index}`, sha256: String(index).repeat(64), mimeType: "image/png", byteLength: index === 0 ? 2097152 : 1024 + index, width: 160, height: 96, encryptedPath: `fixture/${index}.enc`, source: index === 5 ? "clipboard" : "file", trust: "untrusted_attachment", allowedProviders: ["openai"], createdAt: at },
    previewDataUrl: index === 1 ? "" : thumbnail,
    ...(fileName ? { fileName } : {}),
  }));
  win = new BrowserWindow({ show: false, width: 1324, height: 839, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => { throw error; });
  win.webContents.on("console-message", event => { if (event.level === "error") { rendererErrors.push(event.message); console.error("Renderer:", event.message); } });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  // Hidden test windows need page focus for Chromium's native focus scrolling.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  assert.equal(await evaluate("document.hasFocus()"), true);
  await waitFor("document.querySelector('.prompt-add') && document.querySelector('.history-session')", "renderer ready");
  assertCheck(await evaluate("window.harness.request({method:'trace.export',params:{}}).then(() => false, error => error.message.includes('Renderer cannot invoke daemon method: trace.export'))"), "production IPC guard rejects unauthorized methods");
  await openSession("a");
  await waitFor("!document.querySelector('.prompt-add').disabled", "composer is editable");
  await click(".prompt-add");
  await waitFor("document.querySelector('.prompt-add-panel [title=添加图片]')", "add menu exposes image chooser");
  await click('.prompt-add-panel [title="添加图片"]');
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 6", "image chooser populates six Attachment cards");
  assert.equal(requests.filter(request => request.method === "fixture.chooseImages").length, 1);
  checks.push("image chooser receives profile provider scope exactly once");
  await waitFor("[...document.querySelectorAll('[data-slot=attachment-media] img')].every(img=>img.complete && img.naturalWidth > 0)", "valid thumbnails load");
  assertCheck(await evaluate("[...document.querySelectorAll('[data-slot=attachment]')].every(card=>card.dataset.size === 'sm' && card.dataset.orientation === 'vertical')"), "image Attachment cards use the demo vertical layout");
  assertCheck(await evaluate("[...document.querySelectorAll('[data-slot=attachment-media]')].every(media=>{const rect=media.getBoundingClientRect(),content=media.parentElement.querySelector('[data-slot=attachment-content]').getBoundingClientRect();return Math.abs(rect.height-96)<1 && rect.width>100 && rect.bottom<=content.top+1;})"), "thumbnails and fallback occupy a 96 pixel top image area above filename and metadata");
  assertCheck(await evaluate("[...document.querySelectorAll('[data-slot=attachment]')].every(card=>{const action=card.querySelector('[data-slot=attachment-action]').getBoundingClientRect(),content=card.querySelector('[data-slot=attachment-content]').getBoundingClientRect(),rect=card.getBoundingClientRect();return action.top<content.top && action.left>=rect.left && action.right<=rect.right;})"), "remove actions stay over the image area inside each card");
  assert.equal(await evaluate("document.querySelector('[data-attachment-id=attachment-0] [data-slot=attachment-title]').textContent"), names[0]);
  assert.match(await evaluate("document.querySelector('[data-attachment-id=attachment-0] [data-slot=attachment-description]').textContent"), /2(?:\.0)?\s*MB/);
  checks.push("actual filename and formatted byte size are displayed");
  assertCheck(await evaluate("!document.querySelector('.prompt-attachments .glass-strong') && !document.querySelector('.prompt-attachments').textContent.includes('不可信附件') && !document.querySelector('.prompt-attachments').textContent.includes('image/png')"), "legacy glass tile and MIME trust caption are replaced");
  assertCheck(await evaluate("!document.querySelector('[data-attachment-id=attachment-1] img') && !!document.querySelector('[data-attachment-id=attachment-1] [data-slot=attachment-media] svg')"), "missing preview uses an image icon without broken image");
  assertCheck(await evaluate("(() => {const title=document.querySelector('[data-attachment-id=attachment-2] [data-slot=attachment-title]'), style=getComputedStyle(title);return title.scrollWidth>title.clientWidth && style.textOverflow==='ellipsis' && style.whiteSpace==='nowrap';})()"), "long filename is safely ellipsized");
  assertCheck(await evaluate("document.querySelector('[data-attachment-id=attachment-5] [data-slot=attachment-title]').textContent.trim().length > 0"), "restored clipboard attachment receives a readable fallback filename");
  assertCheck(await evaluate("(() => {const group=document.querySelector('[data-slot=attachment-group]'),style=getComputedStyle(group);return style.display==='flex' && style.flexWrap==='nowrap' && style.overflowX==='auto' && document.documentElement.scrollWidth<=innerWidth;})()"), "vertical image cards stay in a horizontal group inside composer");
  await screenshot("attachments-desktop.png");
  await evaluate("(() => {const select=document.querySelector('[aria-label=界面主题]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'kelo');select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor("document.documentElement.dataset.theme === 'kelo' && document.querySelectorAll('[data-slot=attachment]').length === 6", "light Kelo theme retains Attachment cards");
  assertCheck(await evaluate("getComputedStyle(document.querySelector('[data-slot=attachment]')).backgroundColor !== 'rgba(0, 0, 0, 0)'"), "Attachment surface resolves in light theme");
  await screenshot("attachments-kelo.png");
  await evaluate("(() => {const select=document.querySelector('[aria-label=界面主题]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'classic');select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor("document.documentElement.dataset.theme === 'classic'", "classic theme is restored");
  await openSession("b");
  await waitFor("!document.querySelector('[data-slot=attachment-group]')", "other session has a separate empty attachment draft");
  await openSession("a");
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 6", "switching back restores all attachment draft cards");
  win.setSize(760, 700);
  await waitFor("innerWidth === 760", "narrow window applied");
  assertCheck(await evaluate("(() => {const group=document.querySelector('[data-slot=attachment-group]'), prompt=document.querySelector('.workbench-prompt');const g=group.getBoundingClientRect(),p=prompt.getBoundingClientRect();return group.scrollWidth>group.clientWidth && g.right<=p.right+1 && g.left>=p.left-1 && document.documentElement.scrollWidth<=innerWidth;})()"), "narrow attachment row scrolls inside composer without page overflow");
  await screenshot("attachments-narrow.png");
  await evaluate("document.querySelector('[data-attachment-id=attachment-0] [data-slot=attachment-action]').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await waitFor("document.activeElement.closest('[data-attachment-id]')?.dataset.attachmentId === 'attachment-1'", "Tab reaches next attachment remove action");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await waitFor("document.activeElement.closest('[data-attachment-id]')?.dataset.attachmentId === 'attachment-2'", "Tab reaches the clipped third attachment remove action");
  await waitFor("(() => {const button=document.activeElement,r=button.getBoundingClientRect(),g=document.querySelector('[data-slot=attachment-group]').getBoundingClientRect();return r.left>=g.left-1 && r.right<=g.right+1;})()", "focused remove action scrolls into view");
  const removeLabel = `移除附件 ${names[2]}`;
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), removeLabel);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 5 && !document.querySelector('[data-attachment-id=attachment-2]')", "keyboard removal targets the selected attachment");
  assert.equal(requests.filter(request => request.method === "run.start").length, 0);
  checks.push("removing an attachment never submits a run");
  await evaluate("(() => {const field=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'请参考这些图片调整界面');field.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor("!document.querySelector('[aria-label=发送]').disabled", "text and images are ready to submit");
  await click('[aria-label="发送"]');
  await waitFor("!document.querySelector('[data-slot=attachment-group]') && document.querySelector('.prompt-textarea').value === ''", "successful send clears attachment and text draft");
  const submitted = requests.find(request => request.method === "run.start").params;
  assert.deepEqual(submitted.attachments, attachments.filter((_, index) => index !== 2).map(item => item.attachment));
  assert.equal(submitted.request, "请参考这些图片调整界面");
  checks.push("submission retains exact AttachmentRef values without local filename or preview metadata");
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  checks.push("renderer has no runtime errors");
  return { checks, rendererErrors, scratch };
}
main().then(result => { fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0); }).catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) console.error("Attachment geometry:", await evaluate("(() => {const group=document.querySelector('[data-slot=attachment-group]'),button=document.activeElement,rect=el=>el ? {left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}:undefined;return {active:button?.outerHTML,button:rect(button),group:rect(group),scrollLeft:group?.scrollLeft,scrollWidth:group?.scrollWidth,card:rect(button?.closest('[data-slot=attachment]'))};})()"));
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, rendererErrors }, null, 2));
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG());
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
