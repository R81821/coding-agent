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
const sessions = new Map(["a", "b", "c"].map(id => [id, { id, workspacePath: "D:/fixture-attachment-project", profileId: "default", title: `附件会话 ${id}`, createdAt: at, updatedAt: at, reasoningEffort: null }]));
const runs = new Map();
const requests = [];
let attachments;
let files;
let fileChooserError = false;
const importedAttachments = [];
const previewContents = new Map();
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
    case "attachment.preview": {
      const run = runs.get(params.runId);
      if (!run) throw new Error("Attachment preview run not found");
      const attachment = run.spec.attachments?.find(item => item.id === params.attachmentId);
      if (!attachment) throw new Error("Attachment does not belong to this run");
      if (!attachment.mimeType.startsWith("image/")) throw new Error("Attachment is not an image");
      const preview = previewContents.get(attachment.id);
      if (!preview || preview.mimeType !== attachment.mimeType) throw new Error("Attachment preview unavailable");
      return preview;
    }
    case "fixture.chooseImages": assert.deepEqual(params.allowedProviders, profile.allowedProviders); return attachments;
    case "fixture.chooseFiles":
      assert.deepEqual(params.allowedProviders, profile.allowedProviders);
      if (fileChooserError) throw new Error("测试文件读取失败");
      return files;
    case "fixture.putFile":
    case "fixture.putImage": {
      assert.deepEqual(params.allowedProviders, profile.allowedProviders);
      await new Promise(resolve => setTimeout(resolve, 250));
      const id = `imported-${importedAttachments.length}`;
      const attachment = { id, sha256: "a".repeat(64), mimeType: params.mimeType || "text/plain", byteLength: Buffer.from(params.base64, "base64").length, encryptedPath: `fixture/${id}.enc`, source: params.source, trust: "untrusted_attachment", allowedProviders: params.allowedProviders, createdAt: at, ...(params.fileName ? { fileName: params.fileName } : {}) };
      const result = { attachment, previewDataUrl: params.mimeType?.startsWith("image/") ? `data:${params.mimeType};base64,${params.base64}` : "", ...(params.fileName ? { fileName: params.fileName } : {}) };
      if (attachment.mimeType.startsWith("image/")) previewContents.set(id, { mimeType: attachment.mimeType, base64: params.base64 });
      importedAttachments.push(result);
      return result;
    }
    case "run.start": runs.set(params.id, { spec: params, status: "paused", events: [] }); return { runId: params.id };
    case "run.eventPage": return { runId: params.runId, status: "paused", events: [], nextSequence: params.afterSequence ?? -1, hasMore: false };
    default: return [];
  }
}
ipcMain.handle("attachment-fixture", (_event, request) => {
  assert.ok(["fixture.chooseImages", "fixture.chooseFiles", "fixture.putFile", "fixture.putImage"].includes(request.method));
  return fixtureRequest(request);
});
ipcMain.handle("harness:request", (_event, request) => fixtureRequest({ ...request, ...sanitizeRendererRequest(request.method, request.params) }));
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),
  chooseImages:allowedProviders=>ipcRenderer.invoke('attachment-fixture',{method:'fixture.chooseImages',params:{allowedProviders}}),
  chooseFiles:allowedProviders=>ipcRenderer.invoke('attachment-fixture',{method:'fixture.chooseFiles',params:{allowedProviders}}),
  putFile:(base64,mimeType,fileName,source,allowedProviders)=>ipcRenderer.invoke('attachment-fixture',{method:'fixture.putFile',params:{base64,mimeType,fileName,source,allowedProviders}}),
  putImage:(base64,mimeType,source,allowedProviders,fileName)=>ipcRenderer.invoke('attachment-fixture',{method:'fixture.putImage',params:{base64,mimeType,source,allowedProviders,fileName}}),
  desktopCommand:async()=>{},setTitlebarTheme:async()=>{},browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),
  onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
let win;
const checks = [];
const rendererErrors = [];
const sentLayoutMetrics = [];
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
async function waitForFixture(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) { checks.push(label); return; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`${label}: timed out`);
}
async function openSession(id) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes('附件会话 ${id}')).click()`);
  await waitFor("!document.querySelector('.new-task-button').disabled", `opened session ${id}`);
}
async function screenshot(name) {
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(scratch, name), (await win.webContents.capturePage()).toPNG());
}
async function waitForSentImages(ids, label) {
  const selectors = ids.map(id => `.sent-attachment[data-attachment-id="${id}"] img.sent-attachment-image`);
  await waitFor(`document.querySelectorAll('.sent-attachments .sent-attachment').length === ${ids.length} && ${JSON.stringify(selectors)}.every(selector=>{const img=document.querySelector(selector);return img?.complete && img.naturalWidth>0;})`, label);
}
async function assertSentImageLayout(label) {
  const geometry = await evaluate(`(() => {
    const group=document.querySelector('.sent-attachments'),content=group?.closest('.conversation-user-content'),bubble=content?.querySelector('.user-message');
    const rect=element=>{if(!element)return null;const {left,right,top,bottom,width,height}=element.getBoundingClientRect();return {left,right,top,bottom,width,height};};
    return { viewport:innerWidth, pageWidth:document.documentElement.scrollWidth, group:rect(group), bubble:rect(bubble), insideBubble:!!group?.closest('.user-message'), groupStyle:group?{wrap:getComputedStyle(group).flexWrap,justify:getComputedStyle(group).justifyContent,gap:getComputedStyle(group).gap}:null,
      images:[...document.querySelectorAll('.sent-attachment-picture')].map(card=>{const button=card.querySelector('.sent-attachment-open'),img=card.querySelector('img.sent-attachment-image');return {card:rect(card),button:rect(button),image:rect(img),radius:button?getComputedStyle(button).borderRadius:null,fit:img?getComputedStyle(img).objectFit:null,title:card.getAttribute('title'),alt:img?.getAttribute('alt')};}),
      visibleCaptions:[...document.querySelectorAll('.sent-attachment-picture figcaption')].filter(caption=>caption.getClientRects().length && getComputedStyle(caption).visibility!=='hidden').length };
  })()`);
  sentLayoutMetrics.push({ label, ...geometry });
  assertCheck(!!geometry.group && !!geometry.bubble && !geometry.insideBubble, `${label}: sent thumbnails are separate from the text bubble`);
  assertCheck(geometry.group.bottom < geometry.bubble.top && Math.abs(geometry.bubble.top - geometry.group.bottom - 12) < 1, `${label}: thumbnails sit 12 pixels above the text bubble`);
  assertCheck(Math.abs(geometry.group.right - geometry.bubble.right) < 1 && geometry.groupStyle.wrap === "wrap" && geometry.groupStyle.justify === "flex-end", `${label}: thumbnail group aligns right and supports wrapping`);
  const rowRightEdges = new Map();
  for (const item of geometry.images) {
    const row = Math.round(item.card.top);
    rowRightEdges.set(row, Math.max(rowRightEdges.get(row) ?? -Infinity, item.card.right));
  }
  assertCheck([...rowRightEdges.values()].every(right => Math.abs(right - geometry.group.right) < 1), `${label}: every rendered thumbnail row shares the group's right edge`);
  assertCheck(geometry.images.length > 0 && geometry.images.every(item => item.card && item.button && Math.abs(item.card.width - 120) < 1 && Math.abs(item.card.height - 120) < 1 && Math.abs(item.button.width - 120) < 1 && Math.abs(item.button.height - 120) < 1 && Math.abs(item.image.width - item.image.height) < 1 && item.fit === "cover" && item.radius === "14px"), `${label}: thumbnail cards are 120 pixel squares with cover crops and 14 pixel corners`);
  assertCheck(geometry.visibleCaptions === 0 && geometry.images.every(item => item.title && item.alt), `${label}: image filenames remain in title and alt without visible captions`);
  assertCheck(geometry.pageWidth <= geometry.viewport && geometry.images.every(item => item.card.left >= 0 && item.card.right <= geometry.viewport), `${label}: thumbnails do not overflow the viewport horizontally`);
  return geometry;
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
  for (const item of attachments) previewContents.set(item.attachment.id, { mimeType: "image/png", base64: thumbnail.split(",")[1] });
  files = [["项目需求.txt", "text/plain", 3072], ["message-renderer.tsx", "text/plain", 12288], ["sales-dashboard.pdf", "application/pdf", 65536]].map(([fileName, mimeType, byteLength], index) => ({
    attachment: { id: `file-${index}`, sha256: String(index + 6).repeat(64), mimeType, byteLength, encryptedPath: `fixture/file-${index}.enc`, source: "file", trust: "untrusted_attachment", allowedProviders: ["openai"], createdAt: at, fileName },
    previewDataUrl: "",
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
  win.setSize(1324, 839);
  const sentImageIds = submitted.attachments.map(item => item.id);
  await waitForSentImages(sentImageIds, "successful image send displays every sent screenshot as a loaded image");
  await assertSentImageLayout("sent multiple screenshots on desktop");
  assertCheck(requests.some(request => request.method === "attachment.preview" && request.params.runId === submitted.id && request.params.attachmentId === "attachment-1"), "sent image with no draft preview is recovered through the run-scoped preview RPC");
  await screenshot("sent-attachments.png");
  await click('.sent-attachment[data-attachment-id="attachment-0"] .sent-attachment-open');
  await waitFor("!!document.querySelector('dialog.sent-attachment-dialog[open]') && [...document.querySelectorAll('dialog.sent-attachment-dialog[open] img')].some(img=>img.complete && img.naturalWidth>0)", "clicking a sent screenshot opens a loaded large-image dialog");
  await screenshot("sent-attachments-preview.png");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor("!document.querySelector('dialog.sent-attachment-dialog[open]')", "Escape closes the sent screenshot preview");
  assertCheck(await evaluate(`window.harness.request({method:'attachment.preview',params:{runId:${JSON.stringify(submitted.id)},attachmentId:'file-0'}}).then(()=>false,error=>error.message.includes('does not belong'))`), "preview RPC refuses an attachment outside the requested run");
  assertCheck(await evaluate("window.harness.request({method:'attachment.preview',params:{runId:'missing-run',attachmentId:'attachment-0'}}).then(()=>false,error=>error.message.includes('run not found'))"), "preview RPC refuses an unknown run");
  await openSession("b");
  await click(".prompt-add");
  await waitFor("document.querySelector('.prompt-add-panel [title=添加文件]')", "add menu exposes a separate generic file chooser");
  await click('.prompt-add-panel [title="添加文件"]');
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 3", "file chooser imports TXT, TSX and PDF attachments");
  assert.equal(requests.filter(request => request.method === "fixture.chooseFiles").length, 1);
  checks.push("generic file chooser receives profile provider scope");
  assertCheck(await evaluate("[...document.querySelectorAll('[data-slot=attachment]')].every(card=>card.dataset.orientation==='horizontal' && !card.querySelector('img'))"), "ordinary files use horizontal Attachment cards with file icons");
  assert.equal(await evaluate("document.querySelector('[data-attachment-id=file-1] [data-slot=attachment-title]').textContent"), "message-renderer.tsx");
  assert.match(await evaluate("document.querySelector('[data-attachment-id=file-1] [data-slot=attachment-description]').textContent"), /TypeScript.*12\s*KB/);
  assert.match(await evaluate("document.querySelector('[data-attachment-id=file-2] [data-slot=attachment-description]').textContent"), /PDF.*64\s*KB/);
  checks.push("persisted filenames, code type and actual file byte sizes are shown");
  assert.equal(requests.filter(request => request.method === "model.current").at(-1).params.needsVision, false);
  checks.push("a file-only draft does not require a vision model");
  await screenshot("files-desktop.png");
  await openSession("a");
  await waitFor("!document.querySelector('[data-slot=attachment]')", "sent image session has an empty attachment draft");
  await waitForSentImages(sentImageIds, "switching sessions restores sent image attachments independently of the empty draft");
  win.setSize(760, 700);
  await waitFor("innerWidth===760", "sent thumbnail narrow window applied");
  const narrowSentGeometry = await assertSentImageLayout("sent multiple screenshots in a narrow window");
  assertCheck(new Set(narrowSentGeometry.images.map(item => Math.round(item.card.top))).size > 1, "narrow sent screenshots wrap across multiple right-aligned rows");
  await screenshot("sent-attachments-narrow-reference.png");
  win.setSize(1324, 839);
  await openSession("b");
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 3", "generic file drafts restore after switching sessions");
  fileChooserError = true;
  await click(".prompt-add");
  await waitFor("document.querySelector('.prompt-add-panel [title=添加文件]')", "generic file menu can reopen");
  await click('.prompt-add-panel [title="添加文件"]');
  await waitFor("document.querySelector('.composer-upload-error')?.textContent.includes('测试文件读取失败')", "file chooser failure is visible next to composer");
  assert.equal(await evaluate("document.querySelectorAll('[data-slot=attachment]').length"), 3);
  checks.push("a failed file import keeps the existing draft");
  fileChooserError = false;
  await evaluate("(() => {const field=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'请分析代码和这些附件');field.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File(['drop text'],'dragged-notes.txt',{type:'text/plain'}));transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(thumbnail.split(",")[1])}),c=>c.charCodeAt(0))],'dragged-preview.png',{type:'image/png'}));document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
  await waitFor("!!document.querySelector('.composer-upload-status') && document.querySelector('.prompt-send').disabled", "importing dropped files shows pending state and prevents premature send");
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 5 && !document.querySelector('.composer-upload-status')", "a mixed drop imports every file and normalizes the image");
  assert.equal(requests.filter(request => request.method === "fixture.putFile")[0].params.source, "file");
  assert.equal(requests.filter(request => request.method === "fixture.putFile")[0].params.fileName, "dragged-notes.txt");
  assert.equal(requests.filter(request => request.method === "fixture.putImage").length, 1);
  await waitForFixture(() => requests.filter(request => request.method === "model.current").at(-1)?.params.needsVision === true, "image import refreshes model selection with vision enabled");
  checks.push("mixed file drop preserves filenames, uses the file importer and enables vision only for images");
  await evaluate("(() => {const transfer=new DataTransfer();transfer.items.add(new File(['clipboard file'],'clipboard-notes.txt',{type:'text/plain'}));window.dispatchEvent(new ClipboardEvent('paste',{cancelable:true,clipboardData:transfer}));})()");
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 6 && !document.querySelector('.composer-upload-status')", "a pasted nonimage File is imported as an attachment");
  assert.equal(requests.filter(request => request.method === "fixture.putFile").at(-1).params.source, "clipboard");
  checks.push("pasted files retain clipboard source");
  await evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(thumbnail.split(",")[1])}),c=>c.charCodeAt(0))],'pasted-screenshot.png',{type:'image/png'}));window.dispatchEvent(new ClipboardEvent('paste',{cancelable:true,clipboardData:transfer}));})()`);
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 7 && !document.querySelector('.composer-upload-status')", "a pasted screenshot is imported as an image attachment");
  const pastedImage = importedAttachments.at(-1).attachment;
  assert.equal(pastedImage.source, "clipboard");
  assert.equal(pastedImage.mimeType, "image/png");
  checks.push("pasted screenshot import retains image MIME and clipboard source");
  await click('[data-attachment-id="file-0"] [data-slot=attachment-action]');
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 6 && !document.querySelector('[data-attachment-id=file-0]')", "ordinary file remove action targets its own attachment");
  await screenshot("files-and-images-desktop.png");
  win.setSize(760, 700);
  await waitFor("innerWidth===760", "generic file narrow window applied");
  assertCheck(await evaluate("(() => {const group=document.querySelector('[data-slot=attachment-group]'),g=group.getBoundingClientRect(),p=document.querySelector('.workbench-prompt').getBoundingClientRect();return group.scrollWidth>group.clientWidth && g.right<=p.right+1 && document.documentElement.scrollWidth<=innerWidth;})()"), "mixed generic files and image attachments stay inside narrow composer");
  await screenshot("files-and-images-narrow.png");
  await click('[aria-label="发送"]');
  await waitFor("!document.querySelector('[data-slot=attachment-group]') && document.querySelector('.prompt-textarea').value === ''", "successful mixed file send clears draft");
  const mixed = requests.filter(request => request.method === "run.start").at(-1).params;
  const expectedImported = importedAttachments.map(item => item.attachment);
  assert.deepEqual(mixed.attachments, [...files.slice(1).map(item => item.attachment), ...expectedImported]);
  assert.equal(mixed.request, "请分析代码和这些附件");
  checks.push("mixed file submission sends exact persisted refs for PDF, code, text and image without display metadata");
  await waitFor("document.querySelectorAll('.sent-attachments .sent-attachment').length === 6 && document.querySelectorAll('.sent-attachments img.sent-attachment-image').length === 2 && [...document.querySelectorAll('.sent-attachments img.sent-attachment-image')].every(img=>img.complete && img.naturalWidth>0)", "a mixed sent message keeps ordinary files visible alongside dropped and pasted screenshots");
  assertCheck(await evaluate(`(() => {const img=document.querySelector('.sent-attachment[data-attachment-id="${pastedImage.id}"] img.sent-attachment-image');return img?.complete && img.naturalWidth>0;})()`), "a pasted screenshot remains visible after send");
  assertCheck(await evaluate("document.querySelector('.sent-attachment[data-attachment-id=file-1]')?.textContent.includes('message-renderer.tsx') && document.querySelector('.sent-attachment[data-attachment-id=file-2]')?.textContent.includes('sales-dashboard.pdf')"), "sent code and PDF attachments retain their persisted filenames");
  assertCheck(await evaluate(`window.harness.request({method:'attachment.preview',params:{runId:${JSON.stringify(mixed.id)},attachmentId:'file-1'}}).then(()=>false,error=>error.message.includes('not an image'))`), "preview RPC refuses a nonimage owned by the run");
  await screenshot("sent-attachments-mixed.png");
  await evaluate("(() => {const transfer=new DataTransfer();transfer.items.add(new File(['belongs to previous session'],'stale-file.txt',{type:'text/plain'}));document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()");
  await waitFor("!!document.querySelector('.composer-upload-status')", "pending file import is visible before switching session");
  await openSession("a");
  await new Promise(resolve => setTimeout(resolve, 400));
  assertCheck(await evaluate("!document.querySelector('[data-slot=attachment]') && !document.querySelector('.composer-upload-status')"), "a stale file import cannot add an attachment to a different session");
  win.setSize(1324, 839);
  await waitForSentImages(sentImageIds, "returning after a mixed file send restores all earlier screenshot attachments");
  await screenshot("history-attachments-session-return.png");
  const previewRequestsBeforeReload = requests.filter(request => request.method === "attachment.preview").length;
  const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await reloaded;
  await waitFor("document.querySelector('.prompt-add') && document.querySelector('.history-session')", "renderer reload restores the application shell");
  await openSession("a");
  await waitForSentImages(sentImageIds, "renderer reload restores historical screenshots from persisted AttachmentRef values");
  assertCheck(requests.filter(request => request.method === "attachment.preview").length > previewRequestsBeforeReload, "historical image recovery requests persisted preview bytes after a full renderer reload");
  await screenshot("history-attachments-reload.png");
  await evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(thumbnail.split(",")[1])}),c=>c.charCodeAt(0))],'follow-up-screenshot.png',{type:'image/png'}));window.dispatchEvent(new ClipboardEvent('paste',{cancelable:true,clipboardData:transfer}));})()`);
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 1 && !document.querySelector('.composer-upload-status')", "a paused run accepts a screenshot into its follow-up draft");
  await evaluate("(() => {const field=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'追加消息与截图');field.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const startRequestsBeforeFollowup = requests.filter(request => request.method === "run.start").length;
  const steerRequestsBeforeFollowup = requests.filter(request => request.method === "run.steer").length;
  await waitFor("!document.querySelector('[aria-label=发送]').disabled", "paused follow-up text and screenshot are ready to submit");
  await click('[aria-label="发送"]');
  await waitFor("document.querySelector('.composer-upload-error')?.textContent.includes('当前任务的追加消息暂不支持附件') && document.querySelectorAll('[data-slot=attachment]').length === 1 && document.querySelector('.prompt-textarea').value === '追加消息与截图'", "unsupported screenshot follow-up shows an explicit error and preserves the complete draft");
  assert.equal(requests.filter(request => request.method === "run.start").length, startRequestsBeforeFollowup);
  assert.equal(requests.filter(request => request.method === "run.steer").length, steerRequestsBeforeFollowup);
  checks.push("an unsupported attachment follow-up cannot silently send only its text or start another run");
  await screenshot("sent-attachments-followup-guard.png");
  await click('[data-slot=attachment] [data-slot=attachment-action]');
  await evaluate("(() => {const field=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'');field.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor("!document.querySelector('[data-slot=attachment]') && document.querySelector('.prompt-textarea').value === ''", "the guarded follow-up draft can be cleared without altering sent history");
  await openSession("b");
  await waitFor(`document.querySelectorAll('.sent-attachments .sent-attachment').length === 6 && document.querySelector('.sent-attachment[data-attachment-id=file-1]')?.textContent.includes('message-renderer.tsx') && (()=>{const img=document.querySelector('.sent-attachment[data-attachment-id="${pastedImage.id}"] img.sent-attachment-image');return img?.complete && img.naturalWidth>0;})() && [...document.querySelectorAll('.sent-attachments img.sent-attachment-image')].every(img=>img.complete && img.naturalWidth>0)`, "renderer reload also restores mixed files and the pasted screenshot from history");
  await screenshot("history-attachments-mixed-reload.png");
  await openSession("c");
  await waitFor("!document.querySelector('[data-slot=attachment]') && !document.querySelector('.sent-attachments')", "single screenshot reference session starts with an empty composer and history");
  await evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(thumbnail.split(",")[1])}),c=>c.charCodeAt(0))],'single-reference.png',{type:'image/png'}));window.dispatchEvent(new ClipboardEvent('paste',{cancelable:true,clipboardData:transfer}));})()`);
  await waitFor("document.querySelectorAll('[data-slot=attachment]').length === 1 && !document.querySelector('.composer-upload-status')", "single screenshot reference draft is ready");
  await evaluate("(() => {const field=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'已发送图片请像这张参考一样显示');field.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor("!document.querySelector('[aria-label=发送]').disabled", "single screenshot and reference text can be submitted");
  await click('[aria-label="发送"]');
  await waitFor("!document.querySelector('[data-slot=attachment]') && document.querySelector('.prompt-textarea').value === ''", "single screenshot reference send clears its draft");
  const singleRun = requests.filter(request => request.method === "run.start").at(-1).params;
  assert.equal(singleRun.sessionId, "c");
  assert.equal(singleRun.attachments.length, 1);
  await waitForSentImages(singleRun.attachments.map(item => item.id), "single sent screenshot loads above its reference text");
  await assertSentImageLayout("single screenshot and text reference layout");
  await screenshot("sent-attachment-single-reference.png");
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  checks.push("renderer has no runtime errors");
  return { checks, rendererErrors, scratch, sentRuns: [submitted.id, mixed.id, singleRun.id], historicalImageIds: sentImageIds, previewRequestCount: requests.filter(request => request.method === "attachment.preview").length, sentLayoutMetrics };
}
main().then(result => { fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); clearTimeout(timer); app.exit(0); }).catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) console.error("Attachment geometry:", await evaluate("(() => {const group=document.querySelector('[data-slot=attachment-group]'),button=document.activeElement,rect=el=>el ? {left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}:undefined;return {active:button?.outerHTML,button:rect(button),group:rect(group),scrollLeft:group?.scrollLeft,scrollWidth:group?.scrollWidth,card:rect(button?.closest('[data-slot=attachment]'))};})()"));
  fs.writeFileSync(path.join(scratch, "failure.json"), JSON.stringify({ error: String(error), checks, rendererErrors }, null, 2));
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(scratch, "failure.png"), (await win.webContents.capturePage()).toPNG());
  console.error(`Fixture artifacts: ${scratch}`); clearTimeout(timer); app.exit(1);
});
