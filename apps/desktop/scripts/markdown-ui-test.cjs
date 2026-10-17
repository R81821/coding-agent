// Run after the desktop build with Electron. This replays only fixture data in
// an offscreen window with isolated storage; no daemon or provider is started.
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
const scratch = fs.mkdtempSync(path.join(root, ".cache/markdown-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();

const at = "2026-10-16T00:00:00.000Z";
const workspacePath = "D:/fixture-markdown-project";
const sourceUrl = "https://example.com/docs";
const imageUrl = "https://example.com/tracker.png";
const code = 'export function answer(): number {\n  const value = 42;\n  return value;\n}';
const longCell = "宽表格内容需要在消息内部横向滚动";
const finalText = [
  "# 更适合阅读的 Agent 回复", "",
  "正文用 **清晰的层级** 组织信息，保留 `inline code` 与 ~~已过期信息~~。", "",
  "## 已完成的改动", "",
  "- [x] 流式 Markdown", "- [x] 轻量排版", "- [ ] 下一项任务", "",
  "> 用留白和文字层级，让长回答更容易阅读。", "",
  "```typescript", code, "```", "",
  "| 检查项 | 验证结果 | 备注 | 操作者 | 环境 | 执行时间 | 后续 |", "| --- | --- | --- | --- | --- | --- | --- |",
  `| 宽表格 | 通过 | ${longCell} | Agent | Desktop | 2026-10-16 | 完成 |`, "",
  `[参考文档](${sourceUrl}) · ![参考图片](${imageUrl})`, "",
  "[危险链接](javascript:alert%281%29) · [本地链接](file:///C:/secret)", "",
  "<script>window.__unsafeMarkdownExecuted=true</script>",
].join("\n");
const profile = {
  id: "default", name: "Developer", allowedProviders: ["openai"], preferredModels: [],
  skillIds: [], pluginIds: [], toolNames: [],
  budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 },
  routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {},
  verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture",
};
const model = {
  providerId: "openai", modelId: "gpt-6.1-sol", displayName: "OpenAI", healthy: true,
  capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "cloud" },
};
const sessions = new Map(["complete", "stream"].map(id => [id, {
  id, workspacePath, profileId: "default", title: `Markdown ${id}`, createdAt: at, updatedAt: at, reasoningEffort: null,
}]));
function makeRun(id, status) {
  return {
    spec: { id: `run-${id}`, sessionId: id, request: "请展示 Markdown 排版。", workspacePath, profileId: "default", taskMode: "auto", reasoningEffort: null, attachments: [], grants: [], budget: profile.budget, createdAt: at },
    status, events: [],
  };
}
function addEvent(run, payload) {
  const sequence = run.events.length;
  run.events.push({ id: `${run.spec.id}-${sequence}`, runId: run.spec.id, at, sequence, ...payload });
}
const complete = makeRun("complete", "completed");
addEvent(complete, { type: "status", status: "running" });
addEvent(complete, { type: "assistant_turn_started" });
addEvent(complete, { type: "text_delta", delta: finalText });
addEvent(complete, { type: "result", text: finalText, status: "completed", sourceAssistantTurnSequence: 1 });
const stream = makeRun("stream", "running");
addEvent(stream, { type: "status", status: "running" });
addEvent(stream, { type: "assistant_turn_started" });
let streamText = "**流式强调";
addEvent(stream, { type: "text_delta", delta: streamText });
const runs = new Map([["complete", complete], ["stream", stream]]);
const requests = [], openedUrls = [], errors = [], checks = [], blockedImageRequests = [];
let rejectLink = false;
async function fixtureRequest(request) {
  requests.push(request);
  switch (request.method) {
    case "profiles.list": return [profile];
    case "model.current": return { model };
    case "mcp.interactions.list": return { requests: [] };
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "sessions.list": return { items: [...sessions.values()].map(session => ({ ...session, runCount: 1, latestRunId: runs.get(session.id).spec.id, latestStatus: runs.get(session.id).status })), hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath, createdAt: at, updatedAt: at }];
    case "session.view": return { session: sessions.get(request.params.sessionId), runs: [runs.get(request.params.sessionId)], hasMore: false };
    case "run.eventPage": {
      assert.equal(request.params.runId, stream.spec.id);
      const events = stream.events.filter(event => event.sequence > request.params.afterSequence);
      return { runId: stream.spec.id, status: stream.status, events, nextSequence: stream.events.at(-1).sequence, hasMore: false };
    }
    case "run.start":
    case "run.resume": throw new Error("The Markdown replay must never start or resume execution");
    default: return [];
  }
}
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
ipcMain.handle("harness:open-external", (_event, url) => {
  assert.ok([sourceUrl, imageUrl].includes(url), `unexpected external URL: ${url}`);
  if (rejectLink) throw new Error("fixture external link failure");
  openedUrls.push(url);
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),providerSettings:async()=>({}),desktopCommand:async()=>{},setTitlebarTheme:async()=>{},openExternal:url=>ipcRenderer.invoke('harness:open-external',url),
  browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
let win;
const reply = "document.querySelector('.assistant-message .markdown-message')";
const processMessage = "document.querySelector('[data-conversation-process-message]')";
const tokenColors = `[...new Set([...${reply}?.querySelectorAll('.md-code-block code span[style]')??[]].filter(token=>token.textContent.trim()).map(token=>getComputedStyle(token).color))].sort()`;
const evaluate = code => win.webContents.executeJavaScript(code).catch(error => { error.message += `\nEvaluating: ${code}`; throw error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(code)) { checks.push(label); return; }
    await pause(40);
  }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
async function openSession(id) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.querySelector('.history-session-content')?.textContent===${JSON.stringify(sessions.get(id).title)}).click()`);
}
async function screenshot(name) {
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await pause(180);
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
function assertCheck(value, label) { assert.equal(value, true, label); checks.push(label); }
function append(delta) { streamText += delta; addEvent(stream, { type: "text_delta", delta }); }
const timer = setTimeout(() => { console.error("Markdown UI tests timed out"); app.exit(1); }, 90000);
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1320, height: 980, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  // If a regression restores automatic image loading, record and block the
  // request so the fixture cannot contact the remote image host.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["https://example.com/*"] }, (details, callback) => {
    blockedImageRequests.push(details.url); callback({ cancel: true });
  });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelector('.history-session') && document.querySelector('.prompt-textarea')", "production renderer ready");
  await openSession("complete");
  await waitFor(`${reply}?.querySelector('h1')?.textContent==='更适合阅读的 Agent 回复'`, "completed Markdown reply loaded");
  // Keep the OS clipboard untouched while exercising the real copy controls.
  await evaluate("window.__markdownCopies=[];window.__markdownCopyReject=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.__markdownCopyReject)throw new Error('fixture clipboard unavailable');window.__markdownCopies.push(text)}}})");
  assertCheck(await evaluate(`${reply}.querySelectorAll('input[type=checkbox]').length===3 && !!${reply}.querySelector('del') && !!${reply}.querySelector('blockquote') && !!${reply}.querySelector('table')`), "GFM tasks, strikethrough, quotes and tables render");
  await waitFor(`${tokenColors}.length>=3`, "Shiki asynchronously applies multiple syntax colors in the dark theme");
  assert.equal(await evaluate(`${reply}.querySelector('.md-code-block code').textContent.trimEnd()`), code);
  assertCheck(await evaluate(`${reply}.querySelectorAll('.md-code-block').length===1 && !!${reply}.querySelector('p code')`), "only fenced code receives a copy toolbar");
  assertCheck(await evaluate(`!${reply}.querySelector('img,script') && !${reply}.querySelector('a[href^="javascript:"],a[href^="file:"]') && window.__unsafeMarkdownExecuted!==true`), "raw HTML and unsafe URLs remain inert and images use a link placeholder");
  assert.equal(blockedImageRequests.length, 0, "Markdown images must not initiate a remote request");
  await evaluate(`${reply}.querySelector('[aria-label="复制代码"]').click()`);
  await waitFor(`window.__markdownCopies[0]===${JSON.stringify(code)}`, "code copy preserves source text");
  await evaluate(`${reply}.querySelector('[aria-label="复制 Markdown"]').click()`);
  await waitFor(`window.__markdownCopies[1]===${JSON.stringify(finalText)}`, "Markdown copy preserves the entire original reply");
  await evaluate(`window.__markdownCopyReject=true;${reply}.querySelector('[aria-label="复制 Markdown"]').click()`);
  await waitFor(`${reply}.querySelector('[aria-label="复制 Markdown"] [role=status]')?.textContent==='复制失败，请重试'`, "clipboard failures remain visible");
  await evaluate(`window.__markdownCopyReject=false;${reply}.querySelector('[aria-label="复制 Markdown"]').click()`);
  await waitFor(`${reply}.querySelector('[aria-label="复制 Markdown"] [role=status]')?.textContent==='已复制'`, "copy retry clears the failure");
  await evaluate(`[...${reply}.querySelectorAll('button')].find(button=>button.textContent==='查看原文').click()`);
  assert.equal(await evaluate(`${reply}.querySelector('.md-source').textContent`), finalText);
  checks.push("source toggle displays exact Markdown including unsafe text without interpreting it");
  await evaluate(`[...${reply}.querySelectorAll('button')].find(button=>button.textContent==='查看渲染').click()`);
  await waitFor(`${reply}.querySelector('h1')!==null`, "source toggle restores rendered reply");
  await evaluate(`${reply}.querySelector('a[href="${sourceUrl}"]').click()`);
  await evaluate(`${reply}.querySelector('a[href="${imageUrl}"]').click()`);
  assert.deepEqual(openedUrls, [sourceUrl, imageUrl]);
  checks.push("document and image links open through the desktop boundary");
  rejectLink = true;
  await evaluate(`${reply}.querySelector('a[href="${sourceUrl}"]').click()`);
  await waitFor(`${reply}.querySelector('.md-link-error')?.textContent==='链接打开失败'`, "external link failures remain visible");
  rejectLink = false;
  await evaluate(`${reply}.querySelector('a[href="${sourceUrl}"]').click()`);
  await waitFor(`!${reply}.querySelector('.md-link-error')`, "retry clears external link failure");
  await evaluate("document.querySelector('.conversation').scrollTop=0");
  const darkColors = await evaluate(tokenColors);
  await screenshot("markdown-desktop.png");
  await evaluate("(() => {const field=document.querySelector('[aria-label=界面主题]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,'kelo');field.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor("document.documentElement.dataset.theme==='kelo'", "light Kelo theme applied");
  await waitFor(`${tokenColors}.length>=3`, "Shiki applies multiple syntax colors in the light theme");
  assert.notDeepEqual(await evaluate(tokenColors), darkColors, "syntax colors must adapt to the light theme");
  checks.push("syntax palette changes with the appearance tone");
  await screenshot("markdown-light.png");
  win.setSize(760, 880);
  await waitFor("innerWidth===760", "narrow window applied");
  assertCheck(await evaluate(`(() => {const message=${reply},table=message.querySelector('.md-table-scroll');return document.documentElement.scrollWidth<=innerWidth+1 && message.scrollWidth<=message.clientWidth+1 && table.scrollWidth>table.clientWidth && getComputedStyle(table).overflowX==='auto';})()`), "wide table scrolls inside a narrow reply without page overflow");
  await screenshot("markdown-narrow.png");
  await evaluate(`${reply}.querySelector('.md-table-scroll').scrollIntoView({block:'center'})`);
  await screenshot("markdown-details-narrow.png");
  await openSession("stream");
  await waitFor(`${processMessage}?.querySelector('strong')?.textContent==='流式强调'`, "incomplete streamed emphasis renders immediately");
  assertCheck(await evaluate(`${processMessage}.getAttribute('data-streaming')==='true' && !${processMessage}.querySelector('.md-message-actions')`), "live progress uses compact Markdown without final reply actions");
  append("**\n\n请看 [参考文档](https://example.com/doc");
  await waitFor(`${processMessage}?.textContent.includes('参考文档')`, "partial streamed link text arrives");
  assertCheck(await evaluate(`!${processMessage}.querySelector('a')`), "partial streamed destination stays inert");
  append("s)\n\n```typescript\nconst partial = ");
  await waitFor(`${processMessage}?.querySelector('.md-code-block')?.textContent.includes('const partial =')`, "unclosed streamed code fence renders without losing its text");
  assertCheck(await evaluate(`${processMessage}.querySelector('a')?.getAttribute('href')==='${sourceUrl}'`), "completed streamed destination becomes a valid link");
  await screenshot("markdown-streaming.png");
  append("42;\n```\n\n**保留未闭合");
  addEvent(stream, { type: "result", text: streamText, status: "completed", sourceAssistantTurnSequence: 1 });
  stream.status = "completed";
  await waitFor(`${reply}?.textContent.includes('**保留未闭合')`, "completed response preserves unmatched Markdown literally");
  assertCheck(await evaluate(`!${reply}.querySelector('strong')?.textContent.includes('保留未闭合') && !!${reply}.querySelector('.md-message-actions')`), "completion restores static parsing and final reply actions");
  assert.equal(blockedImageRequests.length, 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(!requests.some(request => ["run.start", "run.resume"].includes(request.method)));
  checks.push("fixture never starts execution, loads Markdown images or emits renderer errors");
  return { checks, errors, scratch };
}
main().then(result => {
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0);
}).catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG());
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
