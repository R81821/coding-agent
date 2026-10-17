// Production renderer + actual IPC allowlist, with an isolated fixture backend.
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
const scratch = fs.mkdtempSync(path.join(root, ".cache/memory-ui-"));
app.setPath("userData", path.join(scratch, "user-data"));
app.disableHardwareAcceleration();
const workspace = "D:/fixture-memory-project", at = "2026-10-17T00:00:00.000Z";
const profile = { id: "default", name: "Developer", memoryScopes: ["session", "project", "global"], allowedProviders: [], preferredModels: [], skillIds: [], pluginIds: [], toolNames: [], budget: { maxUsd: 5, maxTurns: 24, maxToolCalls: 128, maxDurationMs: 1800000 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, contextPolicy: {}, verificationPolicy: { items: [] }, sandbox: "local", systemPrompt: "Fixture" };
const session = { id: "memory-session", workspacePath: workspace, profileId: "default", title: "记忆测试会话", createdAt: at, updatedAt: at, reasoningEffort: null };
let memories = [
  { id: "old", content: "本项目使用旧组件库", status: "approved", kind: "convention", key: "ui.library", scope: "project", scopeId: workspace },
  { id: "new", content: "本项目优先使用 shadcn 组件", status: "candidate", kind: "convention", key: "ui.library", scope: "project", scopeId: workspace, conflictIds: ["old"], evidence: [{ source: "run:test:user:0", quote: "用 shadcn 实现" }] },
  { id: "summary", content: "已完成项目界面调整", status: "approved", kind: "summary", scope: "session", scopeId: session.id },
].map(item => ({ source: "run:test", createdAt: at, confidence: 1, pinned: false, ...item }));
const requests = [], errors = [], checks = [];
ipcMain.handle("harness:request", (_event, request) => {
  const safe = guard.exports.sanitizeRendererRequest(request.method, request.params);
  requests.push(safe); const p = safe.params;
  switch (safe.method) {
    case "profiles.list": return [profile];
    case "profiles.memoryScopes": profile.memoryScopes = p.memoryScopes; return profile;
    case "sessions.list": return { items: [{ ...session, runCount: 0 }], hasMore: false };
    case "projects.list": return [{ id: "project", workspacePath: workspace, createdAt: at, updatedAt: at }];
    case "session.view": return { session, runs: [], hasMore: false };
    case "model.current": return {};
    case "conversationTasks.list": return { tasks: [], limits: { maxConcurrentTasks: 4, maxQueueLength: 80 } };
    case "mcp.interactions.list": return { requests: [] };
    case "memory.list": return memories;
    case "memory.create": {
      assert.equal(p.actor, "desktop:user");
      const item = { ...p, id: "manual", status: "approved", createdAt: at, source: p.actor, confidence: 1, pinned: false };
      memories.push(item); return item;
    }
    case "memory.update": {
      assert.equal(p.actor, "desktop:user"); const item = memories.find(item => item.id === p.memoryId);
      Object.assign(item, p.patch, { status: "candidate" }); return item;
    }
    case "memory.decide": {
      const item = memories.find(item => item.id === p.memoryId);
      if (item.conflictIds?.length) {
        assert.equal(p.replaceConflicts, true);
        for (const id of item.conflictIds) memories.find(item => item.id === id).status = "superseded";
      }
      item.status = p.approved ? "approved" : "rejected"; item.conflictIds = []; return item;
    }
    case "memory.publishPreview":
      assert.deepEqual(p.memoryIds, ["new"]);
      return { workspacePath: workspace, memoryIds: p.memoryIds, token: "a".repeat(64), files: [{ path: "AGENTS.md", before: "手写规范", after: "手写规范\n本项目优先使用 shadcn 组件" }, { path: "docs/agent-knowledge.md", before: "", after: "项目知识" }] };
    case "memory.publish":
      assert.deepEqual(p.memoryIds, ["new"]); assert.equal(p.token, "a".repeat(64)); return { paths: [workspace + "/AGENTS.md"] };
    default: return [];
  }
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{
  desktopPlatform:'win32',restoreUnlock:async()=>({ok:true}),request:request=>ipcRenderer.invoke('harness:request',request),
  desktopCommand:async()=>{},setTitlebarTheme:async()=>{},browserState:async(sessionId)=>({sessionId,tabs:[],visible:false,revealVersion:0}),
  onBrowserState:()=>()=>{},browserLayout:async()=>{},browserCommand:async()=>{},chooseWorkspace:async()=>undefined
});`);
let win;
const evaluate = code => win.webContents.executeJavaScript(code);
async function waitFor(code, label) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await evaluate(code)) { checks.push(label); console.log(label); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: timed out\n${await evaluate("document.body.innerText")}`);
}
async function button(text, within = "document") {
  await evaluate(`[...${within}.querySelectorAll('button')].find(button=>button.textContent.includes(${JSON.stringify(text)})).click()`);
}
async function fill(label, value, tag = "input") {
  await evaluate(`(()=>{const field=document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(${tag === "textarea" ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
const timer = setTimeout(() => { console.error("Memory UI test timed out"); app.exit(1); }, 60000);
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1324, height: 920, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelector('.history-session')", "renderer loaded");
  await evaluate("document.querySelector('.history-session').click()");
  await waitFor("!document.querySelector('.new-task-button').disabled", "project session opened");
  await evaluate("document.querySelector('.sidebar-tools').open=true");
  await button("记忆", "document.querySelector('.sidebar-tools')");
  await waitFor("document.querySelector('.memory-manager')", "memory manager opened");
  assert.equal(await evaluate("[...document.querySelectorAll('.memory-manager input[type=checkbox]')].every(input=>input.checked)"), true);
  checks.push("all three scopes initially checked");
  await button("替换旧记忆并记住");
  await waitFor("document.querySelector('[data-memory-id=old]').textContent.includes('已被替换')", "conflict replacement reflected");
  await button("新增记忆");
  await fill("记忆主题", "response.language"); await fill("记忆正文", "以后默认用中文回答", "textarea");
  await button("保存并记住");
  await waitFor("document.querySelector('[data-memory-id=manual]')", "manual global preference saved");
  assert.equal(memories.find(item => item.id === "manual").scope, "global");
  await button("编辑", "document.querySelector('[data-memory-id=summary]')");
  assert.equal(await evaluate("!!document.querySelector('[data-memory-id=summary] [aria-label=记忆分类]')"), false);
  await fill("记忆正文", "更新后的会话摘要", "textarea"); await button("保存修改");
  await waitFor("document.querySelector('[data-memory-id=summary]').textContent.includes('更新后的会话摘要') && !document.querySelector('[aria-label=记忆正文]')", "session summary stays editable");
  const summaryPatch = requests.find(request => request.method === "memory.update").params.patch;
  assert.equal(summaryPatch.scope, undefined); assert.equal(summaryPatch.kind, undefined);
  await button("同步项目规范与知识");
  await waitFor("document.querySelector('[aria-label=项目知识变更预览]')", "project diff preview opened");
  assert.equal(requests.some(request => request.method === "memory.publish"), false);
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(scratch, "memory-preview.png"), (await win.webContents.capturePage()).toPNG());
  await button("应用并信任项目规范");
  await waitFor("!document.querySelector('[aria-label=项目知识变更预览]') && document.body.textContent.includes('项目知识已同步')", "exact reviewed changes applied");
  await evaluate("[...document.querySelectorAll('.memory-manager input[type=checkbox]')][2].click()");
  await waitFor("![...document.querySelectorAll('.memory-manager input[type=checkbox]')][2].checked", "global opt-out persisted through refresh");
  assert.deepEqual(profile.memoryScopes, ["session", "project"]);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(scratch, "memory-manager.png"), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, screenshots: scratch }, null, 2));
  clearTimeout(timer); app.exit(0);
}
main().catch(error => { console.error(error); clearTimeout(timer); app.exit(1); });
