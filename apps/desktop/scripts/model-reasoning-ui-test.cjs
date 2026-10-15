// Run after pnpm --filter @harness/desktop build. Tests the real renderer against
// fixture IPC in isolated Electron storage; no vault, credentials or provider calls.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
// Compile the production IPC guard instead of duplicating its whitelist in fixtures.
const guardPath = path.join(root, "apps/desktop/src/renderer-ipc.ts");
const guardModule = new Module(guardPath, module);
guardModule._compile(ts.transpileModule(fs.readFileSync(guardPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, guardPath);
const { sanitizeRendererRequest } = guardModule.exports;
const scratch = fs.mkdtempSync(path.join(root, ".cache/model-reasoning-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();
const at = "2026-10-10T00:00:00.000Z";
const profile = { id: "default", name: "Developer", allowedProviders: ["openai", "openai-compatible"], preferredModels: [], skillIds: [], pluginIds: [], toolNames: [], budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {}, verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture" };
const capabilities = { vision: true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "cloud" };
const models = [
  { providerId: "openai", modelId: "gpt-6.1-sol", displayName: "OpenAI", capabilities: { ...capabilities, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }, healthy: true },
  { providerId: "openai-compatible", modelId: "custom-model", displayName: "Custom Model", capabilities, healthy: true },
];
let configuredModel = models[0];
let providerConfig = { openaiCompatibleBaseUrl: "https://fixture.test/v1", openaiCompatibleModel: "gpt-6.1-sol" };
const sessions = new Map(["a", "b", "paused"].map(id => [id, { id, workspacePath: "D:/fixture-model-project", profileId: "default", title: `会话 ${id}`, createdAt: at, updatedAt: at, reasoningEffort: id === "a" ? "xhigh" : null }]));
const runs = new Map();
runs.set("parked", { spec: { id: "parked", sessionId: "paused", request: "暂停任务", workspacePath: "D:/fixture-model-project", profileId: "default", reasoningEffort: null, attachments: [], grants: [], budget: profile.budget, createdAt: at }, status: "paused", events: [] });
const requests = [];
let rejectSave = false;
let pendingSave;
let holdSave = false;
function sessionRuns(id) { return [...runs.values()].filter(run => run.spec.sessionId === id); }
async function fixtureRequest(request) {
  requests.push(request);
  const params = request.params;
  switch (request.method) {
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "mcp.interactions.list": return { requests: [] };
    case "fixture.providerSettings": return providerConfig;
    case "fixture.saveProviderSettings": {
      providerConfig = { ...params };
      configuredModel = { ...models[0], modelId: providerConfig.openaiCompatibleModel, displayName: "Alias differs from configured ID" };
      return providerConfig;
    }
    case "profiles.list": return [profile];
    case "model.current": return { model: configuredModel };
    case "sessions.list": return { items: [...sessions.values()].map(session => { const owned = sessionRuns(session.id); return { ...session, runCount: owned.length, ...(owned[0] ? { latestRunId: owned[0].spec.id, latestStatus: owned[0].status } : {}) }; }), hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath: "D:/fixture-model-project", createdAt: at, updatedAt: at }];
    case "session.view": return { session: sessions.get(params.sessionId), runs: sessionRuns(params.sessionId), hasMore: false };
    case "session.reasoning": {
      if (rejectSave) throw new Error("fixture save rejected");
      if (holdSave) await new Promise(resolve => { pendingSave = resolve; });
      const session = { ...sessions.get(params.sessionId), reasoningEffort: params.reasoningEffort, profileId: params.profileId ?? "default" };
      sessions.set(session.id, session); return session;
    }
    case "run.start": runs.set(params.id, { spec: params, status: "paused", events: [] }); return { runId: params.id };
    case "run.eventPage": return { runId: params.runId, status: "paused", events: [], nextSequence: params.afterSequence ?? -1, hasMore: false };
    default: return [];
  }
}
ipcMain.handle("model-fixture", (_event, request) => {
  assert.ok(request.method.startsWith("fixture."));
  return fixtureRequest(request);
});
ipcMain.handle("harness:request", (_event, request) => {
  const sanitized = sanitizeRendererRequest(request.method, request.params);
  return fixtureRequest({ ...request, ...sanitized });
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),
  providerSettings:()=>ipcRenderer.invoke('model-fixture',{method:'fixture.providerSettings'}),
  setProviderSettings:params=>ipcRenderer.invoke('model-fixture',{method:'fixture.saveProviderSettings',params}),
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
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}\nFocused: ${await evaluate("document.activeElement?.outerHTML.slice(0,300)")}`);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function openSession(id) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes('会话 ${id}')).click()`);
  await waitFor("!document.querySelector('.new-task-button').disabled", `opened session ${id}`);
}
async function settlePopup() {
  await evaluate("(async () => { await Promise.all((document.querySelector('.model-reasoning-popover')?.getAnimations() ?? []).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()");
}
async function captureSlime() {
  const motion = await evaluate("(() => { const popup=document.querySelector('.model-reasoning-popover'); window.__modelReveal=popup.getAnimations()[0]; const animation=window.__modelReveal; animation.pause(); const trigger=document.querySelector('.model-reasoning-trigger').getBoundingClientRect(), left=parseFloat(popup.style.left), top=parseFloat(popup.style.top); return {duration:animation.effect.getComputedTiming().duration,rect:{x:Math.floor(left-30),y:Math.floor(top-15),width:Math.ceil(popup.offsetWidth+60),height:Math.ceil(trigger.bottom-top+30)}}; })()");
  assert.ok(motion.duration >= 400 && motion.duration <= 600);
  const frames = [];
  const transforms = [];
  for (const fraction of [0, .12, .25, .36, .48, .59, .7, .86, 1]) {
    await evaluate(`window.__modelReveal.currentTime=${motion.duration * fraction}`);
    await new Promise(resolve => setTimeout(resolve, 45));
    transforms.push(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-popover')).transform"));
    const filename = `slime-${frames.length}.png`;
    fs.writeFileSync(path.join(scratch, filename), (await win.webContents.capturePage(motion.rect)).toPNG());
    frames.push({ filename, time: motion.duration * fraction });
  }
  assert.ok(new Set(transforms).size >= 5);
  await evaluate("window.__modelReveal.finish(); delete window.__modelReveal");
  fs.writeFileSync(path.join(scratch, "slime-frames.json"), JSON.stringify({ duration: motion.duration, frames }, null, 2));
  checks.push("slime reveal stretches and rebounds before settling at original size");
}
async function captureMeteors(rect) {
  const count = await evaluate("(() => { const layer=document.querySelector('.model-reasoning-meteors'); if (!layer) return 0; window.__meteorAnimations=layer.getAnimations({subtree:true}); window.__meteorAnimations.forEach(animation => animation.pause()); return window.__meteorAnimations.length; })()");
  assert.ok(count >= 2 && count <= 6);
  assert.equal(await evaluate("document.querySelector('.model-reasoning-meteors').getAttribute('aria-hidden')"), "true");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-meteors')).pointerEvents"), "none");
  const frames = [];
  const transforms = [];
  for (let index = 0; index < 80; index++) {
    const time = index * 80;
    await evaluate(`window.__meteorAnimations.forEach(animation => { animation.currentTime=${time}; })`);
    await new Promise(resolve => setTimeout(resolve, 35));
    transforms.push(await evaluate("[...document.querySelector('.model-reasoning-meteors').children].map(el => getComputedStyle(el).transform).join('|')"));
    const filename = `meteor-${index}.png`;
    fs.writeFileSync(path.join(scratch, filename), (await win.webContents.capturePage(rect)).toPNG());
    frames.push({ filename, time });
  }
  assert.ok(new Set(transforms).size > 10);
  assert.equal(await evaluate("[...document.querySelectorAll('.model-reasoning-tier > span')].every(el => { const r=el.getBoundingClientRect(); return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.model-reasoning-tier') === el.parentElement; })"), true);
  await evaluate("window.__meteorAnimations.forEach(animation => animation.play()); delete window.__meteorAnimations");
  fs.writeFileSync(path.join(scratch, "meteor-frames.json"), JSON.stringify({ duration: 6400, frames }, null, 2));
  checks.push("background meteors animate without blocking tier clicks");
}
async function screenshot(name) {
  await settlePopup();
  // Offscreen rendering submits compositor frames without changing window focus.
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
async function checkTierSpacing(label) {
  const centers = await evaluate("[...document.querySelectorAll('.model-reasoning-tier > span')].map(el => { const rect=el.getBoundingClientRect(); return rect.top+rect.height/2; })");
  assert.equal(centers.length, 4);
  const gaps = centers.slice(1).map((center, index) => center - centers[index]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1, `Unequal tier spacing: ${JSON.stringify(gaps)}`);
  checks.push(label);
}
const timer = setTimeout(() => { console.error("Model UI tests timed out"); app.exit(1); }, 90000);
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1320, height: 860, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => { throw error; });
  win.webContents.on("console-message", event => { if (event.level === "error") { rendererErrors.push(event.message); console.error("Renderer:", event.message); } });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  // Interaction assertions are kept here so they exercise the built renderer and
  // its actual session.reasoning/run.start IPC payloads together.
  await waitFor("document.querySelector('.model-reasoning-trigger') && document.querySelector('.history-session')", "renderer ready");
  assert.equal(await evaluate("window.harness.request({method:'trace.export',params:{}}).then(() => false, error => error.message.includes('Renderer cannot invoke daemon method: trace.export'))"), true);
  checks.push("production IPC boundary still rejects unauthorized renderer methods");
  await openSession("a");
  await waitFor("document.querySelector('.model-reasoning-trigger')?.textContent.includes('Ultra')", "restored model and reasoning setting");
  assert.equal(await evaluate("document.querySelector('.model-reasoning-current-model').textContent"), configuredModel.modelId);
  checks.push("composer displays the exact configured model ID");
  assert.equal(await evaluate("document.querySelector('.model-reasoning-trigger').compareDocumentPosition(document.querySelector('.prompt-current-mode')) & Node.DOCUMENT_POSITION_FOLLOWING"), 4);
  checks.push("model button precedes Auto");
  await screenshot("composer.png");
  // The selectors below follow the component's accessible controls.
  await click(".model-reasoning-trigger");
  await waitFor("document.querySelector('.model-reasoning-popover') && getComputedStyle(document.querySelector('.model-reasoning-popover')).visibility === 'visible'", "opens reasoning selector");
  await captureSlime();
  await screenshot("selector.png");
  await checkTierSpacing("four tier labels have equal vertical spacing");
  const detail = await evaluate("(() => { const popup=document.querySelector('.model-reasoning-popover').getBoundingClientRect(), trigger=document.querySelector('.model-reasoning-trigger').getBoundingClientRect(); return {x:Math.floor(Math.min(popup.left,trigger.left)-14),y:Math.floor(popup.top-10),width:Math.ceil(Math.max(popup.right,trigger.right)-Math.min(popup.left,trigger.left)+28),height:Math.ceil(trigger.bottom-popup.top+20)}; })()");
  fs.writeFileSync(path.join(scratch, "selector-detail.png"), (await win.webContents.capturePage(detail)).toPNG());
  await captureMeteors(detail);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.model-reasoning-tier')].map(el=>el.textContent.trim())"), ["Ultra", "High", "Medium", "Low"]);
  assert.equal(await evaluate("document.querySelector('.model-reasoning-tip, [aria-label=\"使用模型默认推理等级\"]') === null"), true);
  assert.match(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-triangle')).clipPath"), /^url\(/);
  assert.equal(await evaluate("(() => { const triangle=document.querySelector('.model-reasoning-triangle'), r=triangle.getBoundingClientRect(); return !triangle.contains(document.elementFromPoint(r.left+1,r.top+1)) && !triangle.contains(document.elementFromPoint(r.right-1,r.top+1)) && triangle.contains(document.elementFromPoint(r.left+r.width/2,r.top+10)); })()"), true);
  checks.push("rounded triangle clips its upper corners while retaining selectable tiers");
  assert.equal(await evaluate("document.querySelector('.model-reasoning-popover [role=listbox], .model-reasoning-models, .model-reasoning-heading') === null"), true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-popover')).backgroundColor"), "rgba(0, 0, 0, 0)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-popover')).borderTopWidth"), "0px");
  checks.push("only frameless reasoning triangle, no model selector");
  const gradient = await evaluate("getComputedStyle(document.querySelector('.model-reasoning-triangle')).backgroundImage");
  assert.equal(gradient.replace("to bottom, ", ""), "linear-gradient(rgb(252, 176, 69), rgb(253, 29, 29), rgb(131, 58, 180))");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-tier[aria-checked=true]')).color"), "rgb(28, 51, 227)");
  assert.equal(await evaluate("[...document.querySelectorAll('.model-reasoning-tier')].every(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', 'normal'].includes(getComputedStyle(el, '::after').content))"), true);
  checks.push("continuous requested gradient has no tier lines and selected text is blue");
  await waitFor("document.activeElement.getAttribute('aria-label') === '推理等级 Ultra'", "selected strength receives focus");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
  await waitFor("document.activeElement.getAttribute('aria-label') === '推理等级 High'", "arrow key moves between strength tiers");
  await click('[aria-label="推理等级 High"]');
  await waitFor("document.querySelector('.model-reasoning-trigger').textContent.includes('High') && !document.querySelector('.model-reasoning-trigger').disabled", "committed reasoning change");
  assert.equal(sessions.get("a").reasoningEffort, "high");
  await click(".model-reasoning-trigger");
  await waitFor("document.querySelector('.model-reasoning-popover') && getComputedStyle(document.querySelector('.model-reasoning-popover')).visibility === 'visible'", "reopens selected High tier");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-reasoning-triangle')).backgroundImage"), gradient);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"推理等级 High\"]')).color"), "rgb(28, 51, 227)");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"推理等级 Ultra\"]')).color"), "rgb(28, 51, 227)");
  checks.push("selection changes text color without changing gradient background");
  await screenshot("selector-high.png");
  await evaluate("document.querySelector('.prompt-textarea').focus()");
  configuredModel = models[1];
  win.reload();
  await waitFor("document.querySelector('.model-reasoning-current-model')?.textContent === 'custom-model'", "configured model ID overrides its display name");
  await click(".model-reasoning-trigger");
  await waitFor("document.querySelectorAll('.model-reasoning-tier:disabled').length === 4", "unknown model cannot send unsupported reasoning levels");
  await evaluate("document.querySelector('.prompt-textarea').focus()");
  configuredModel = models[0];
  win.reload();
  await waitFor("document.querySelector('.model-reasoning-current-model')?.textContent === 'gpt-6.1-sol' && !document.querySelector('.model-reasoning-trigger').disabled", "new settings determine displayed model ID without formatting");
  await click(".model-reasoning-trigger");
  await click('[aria-label="推理等级 Ultra"]');
  await waitFor("document.querySelector('.model-reasoning-trigger').textContent.includes('Ultra') && !document.querySelector('.model-reasoning-trigger').disabled", "Ultra maps to xhigh");
  assert.equal(sessions.get("a").reasoningEffort, "xhigh");
  rejectSave = true;
  await click(".model-reasoning-trigger");
  await click('[aria-label="推理等级 Medium"]');
  await waitFor("document.querySelector('.workbench-prompt [role=alert]')?.textContent.includes('fixture save rejected')", "failed save is visible");
  assert.equal(sessions.get("a").reasoningEffort, "xhigh");
  assert.ok(await evaluate("document.querySelector('.model-reasoning-trigger').textContent.includes('Ultra')"));
  rejectSave = false;
  await click(".model-reasoning-trigger");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
  await waitFor("!document.querySelector('.model-reasoning-popover') && document.activeElement.matches('.model-reasoning-trigger')", "Escape closes and restores focus");
  await click(".model-reasoning-trigger");
  await evaluate("document.querySelector('.prompt-textarea').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.querySelector('.prompt-textarea').focus()");
  await waitFor("!document.querySelector('.model-reasoning-popover')", "outside click closes selector");
  holdSave = true;
  await click(".model-reasoning-trigger");
  await click('[aria-label="推理等级 High"]');
  await waitFor("document.querySelector('.model-reasoning-trigger').disabled", "saving prevents simultaneous sends");
  await openSession("b");
  assert.equal(typeof pendingSave, "function");
  holdSave = false; pendingSave();
  await waitFor("!document.querySelector('.model-reasoning-trigger').disabled && document.querySelector('.model-reasoning-current-effort').textContent === '推理'", "late save does not overwrite another session");
  assert.equal(sessions.get("b").reasoningEffort, null);
  await openSession("a");
  await waitFor("document.querySelector('.model-reasoning-trigger').textContent.includes('High')", "selection belongs to its session");
  win.reload();
  await waitFor("document.querySelector('.model-reasoning-trigger')?.textContent.includes('High')", "selection survives renderer reload");
  await evaluate("const field=document.querySelector('.prompt-textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'测试推理等级'); field.dispatchEvent(new Event('input',{bubbles:true}));");
  await waitFor("!document.querySelector('[aria-label=发送]').disabled", "composer ready to submit selected setting");
  await click('[aria-label="发送"]');
  await waitFor("document.querySelector('.model-reasoning-trigger').disabled && document.querySelector('[aria-label=继续]')", "paused run locks selection");
  const submitted = requests.find(request => request.method === "run.start").params;
  assert.equal(submitted.reasoningEffort, "high");
  assert.equal("modelSelection" in submitted, false);
  checks.push("new run sends strength without model override");
  await openSession("paused");
  await waitFor("document.querySelector('.model-reasoning-trigger').disabled && document.querySelector('.model-reasoning-current-effort').textContent === '推理'", "restored paused run remains locked");
  await openSession("b");
  await waitFor("!document.querySelector('.model-reasoning-trigger').disabled", "idle session becomes editable");
  win.setSize(900, 680);
  await click(".model-reasoning-trigger");
  await waitFor("document.querySelector('.model-reasoning-popover') && getComputedStyle(document.querySelector('.model-reasoning-popover')).visibility === 'visible'", "opens compact selector");
  await settlePopup();
  await waitFor("document.querySelector('.model-reasoning-popover')?.getBoundingClientRect().right <= innerWidth - 10 && document.querySelector('.model-reasoning-popover')?.getBoundingClientRect().top >= 10", "selector fits compact window");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  const compactGeometry = await evaluate("({top:document.querySelector('.model-reasoning-popover').getBoundingClientRect().top,cardsBottom:document.querySelector('.task-starters').getBoundingClientRect().bottom,transform:getComputedStyle(document.querySelector('.model-reasoning-popover')).transform})");
  assert.ok(compactGeometry.top >= compactGeometry.cardsBottom - 1, JSON.stringify(compactGeometry));
  assert.equal(await evaluate("document.querySelector('.model-reasoning-popover').getBoundingClientRect().width <= 178"), true);
  assert.equal(await evaluate("document.querySelectorAll('.model-reasoning-tier').length === 4"), true);
  checks.push("compact triangle stays below starter cards");
  await screenshot("compact.png");
  await checkTierSpacing("tier labels stay equally spaced in compact window");
  await click('[aria-label="推理等级 Low"]');
  await waitFor("!document.querySelector('.model-reasoning-popover') && document.querySelector('.model-reasoning-current-effort').textContent === 'Low' && !document.querySelector('.model-reasoning-trigger').disabled", "Low tier including triangle tip is usable");
  assert.equal(requests.filter(request => request.method === "session.reasoning").at(-1).params.reasoningEffort, "low");
  await evaluate("window.__rendererReloadToken='same-renderer'");
  await click(".sidebar-settings");
  await waitFor("document.querySelector('.settings-layout')", "opens provider settings");
  await evaluate("[...document.querySelectorAll('.settings-navigation nav button')].find(el => el.textContent.includes('兼容 API')).click()");
  await waitFor("document.querySelector('[aria-label=\"模型 ID\"]') && !document.querySelector('#settings-provider fieldset').disabled", "provider settings finish loading");
  const savedModelId = "gpt-6.1-sol-2026-10-01";
  await evaluate(`(() => { const field=document.querySelector('[aria-label="模型 ID"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(savedModelId)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click("#settings-provider .settings-actions button");
  await waitFor("document.querySelector('#settings-provider [role=status]')?.textContent.includes('已保存并重新加载运行时')", "settings save refreshes runtime model data");
  assert.equal(providerConfig.openaiCompatibleModel, savedModelId);
  await click('[aria-label="返回工作台"]');
  await waitFor(`document.querySelector('.model-reasoning-current-model')?.textContent === ${JSON.stringify(savedModelId)} && !document.querySelector('.model-reasoning-trigger').disabled`, "saved model ID reaches composer without renderer reload");
  assert.equal(await evaluate("window.__rendererReloadToken"), "same-renderer");
  assert.ok(await evaluate(`document.querySelector('.model-reasoning-trigger').getAttribute('aria-label').includes(${JSON.stringify(savedModelId)})`));
  await screenshot("settings-model-id.png");
  return { checks, scratch };
}
main().then(result => {
  assert.ok(requests.some(request => request.method === "model.current"));
  assert.ok(requests.some(request => request.method === "session.reasoning"));
  assert.ok(!requests.some(request => request.method === "session.model" || request.method === "models.list"));
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0);
}).catch(async error => { console.error(error); fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, rendererErrors }, null, 2)); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG()); console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1); });
