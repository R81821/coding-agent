// Run with stock Electron after pnpm build. Uses fixture IPC and isolated userData.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(root, ".cache/history-ui-"));
app.setPath("userData", path.join(scratch, "profile"));
app.disableHardwareAcceleration();
const runs = new Map();
let failDetail = false;
function save(id, request, text, status = "completed", createdAt = "2026-09-01T00:00:00.000Z") {
  const spec = { id, sessionId: `session-${id}`, request, workspacePath: "D:/fixture-project", profileId: "default", attachments: [], grants: [], budget: {}, createdAt };
  runs.set(id, { spec, status, events: [{ id: `event-${id}`, runId: id, at: createdAt, sequence: 0, type: "result", text, status }] });
}
const markdownFixture = fs.readFileSync(path.join(__dirname, "markdown-fixture.md"), "utf8");
save("old-a", "历史任务 A", markdownFixture);
const workflow = {
  phase: "final_review", objective: "检查仓库", intent: "change", requirements: ["修复目标行为"], context: "已检查入口与测试", plan: ["最小修改"],
  hypotheses: [{ cause: "边界条件未处理", evidenceIds: ["read-1"], revision: 1 }], observations: [], verification: [], relevantFiles: ["src/value.ts"], changedFiles: ["src/value.ts"],
  revision: 1, localRevision: 1, broaderRevision: 1, diffRevision: 1, requirementsRevision: 1, reviewedRevision: 1, failures: 1, diagnosisRequired: false, lastFailure: "", requirementEvidence: ["测试通过"], review: "已检查边界条件与修改范围",
};
runs.get("old-a").events[0].sequence = 1;
runs.get("old-a").events.unshift({ id: "workflow-fixture", runId: "old-a", at: "2026-09-01T00:00:00.000Z", sequence: 0, type: "workflow_updated", workflow, detail: "已检查边界条件与修改范围" });
save("old-b", "历史任务 B", "历史回答 B：保留失败诊断。", "failed");
save("old-c", "其他项目任务", "其他项目回答。");
runs.get("old-c").spec.workspacePath = "D:/other-project";
runs.get("old-c").spec.createdAt = "2026-08-01T00:00:00.000Z";
ipcMain.handle("history-fixture", (_event, request) => {
  switch (request.method) {
    case "profiles.list": return [{ id: "default", name: "Fixture Developer", allowedProviders: ["openai-compatible"], budget: {} }];
    case "runs.list": {
      const items = [...runs.values()].map(({ spec, status }) => ({ ...spec, status })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const offset = request.params?.offset ?? 0;
      const limit = request.params?.limit ?? 50;
      return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit };
    }
    case "run.get": {
      if (failDetail) throw new Error("fixture detail unavailable");
      const run = runs.get(request.params.runId);
      return run && { spec: run.spec, status: run.status };
    }
    case "run.events": return (runs.get(request.params.runId)?.events ?? []).filter((event) => event.sequence > request.params.afterSequence);
    case "run.start": {
      const id = request.params.id;
      save(id, request.params.request, "# 新会话回答\n\n```js\nconst stream = 42;\n```", "running", request.params.createdAt);
      const run = runs.get(id);
      const result = { ...run.events[0], sequence: 1, status: "completed" };
      run.events = [{ ...result, sequence: 0, type: "text_delta", delta: "# 新会话回答\n\n```js\nconst stream =" }];
      setTimeout(() => { run.events.push(result); run.status = "completed"; }, 1500);
      return { runId: id };
    }
    default: return [];
  }
});
let openedLink;
ipcMain.handle("history-open-link", (_event, url) => { openedLink = url; });
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{restoreUnlock:async()=>({ok:true}),openExternal:async(url)=>ipcRenderer.invoke("history-open-link",url),request:(request)=>ipcRenderer.invoke('history-fixture',request)});`);
let win;
const checks = [];
const evaluate = (code) => win.webContents.executeJavaScript(code);
async function waitFor(code, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(code)) { checks.push(label); return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}`);
}
async function openHistory(title, answer) {
  await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes(${JSON.stringify(title)})).click()`);
  await waitFor(`document.querySelector('.assistant-message')?.textContent.includes(${JSON.stringify(answer)}) && !document.querySelector('.new-task-button').disabled`, `restore ${title}`);
}
const timer = setTimeout(() => { console.error("History UI smoke timeout"); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelectorAll('.history-session').length === 2", "history loads before choosing a project");
  await openHistory("历史任务 A", "历史回答 A");
  await evaluate("document.querySelector('.new-task-button').click()");
  await waitFor("!document.querySelector('.user-message') && !document.querySelector('.assistant-message') && document.querySelectorAll('.history-session').length === 2", "new task clears current view and retains history");
  await openHistory("历史任务 B", "历史回答 B");
  await openHistory("历史任务 A", "历史回答 A");
  await waitFor("document.querySelectorAll('.project-group').length === 2 && [...document.querySelectorAll('.history-session')].every(el => el.closest('.project-group-items'))", "history belongs to project children");
  await evaluate("[...document.querySelectorAll('.project-folder')].find(el => el.title === 'D:/other-project').click()");
  await waitFor("document.querySelectorAll('.history-session').length === 3", "expand second project");
  await openHistory("其他项目任务", "其他项目回答");
  await waitFor("document.querySelector('.composer-project-bar').textContent.includes('other-project')", "restore switches to correct project");
  await evaluate("[...document.querySelectorAll('.project-folder')].find(el => el.title === 'D:/other-project').click()");
  await waitFor("document.querySelectorAll('.history-session').length === 2", "collapse hides only that project's children");
  await openHistory("历史任务 A", "历史回答 A");
  failDetail = true;
  await evaluate("[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes('历史任务 B')).click()");
  await waitFor("document.querySelector('.history-error')?.textContent.includes('无法打开历史记录') && !document.querySelector('.new-task-button').disabled && document.querySelector('.assistant-message')?.textContent.includes('历史回答 A')", "failed restore preserves current view and visible error");
  failDetail = false;
  await evaluate("document.querySelector('.new-task-button').click()");
  await waitFor("document.querySelector('.task-starter') !== null", "new task starter appears");
  await evaluate("document.querySelector('.task-starter').click()");
  await waitFor("document.querySelector('.prompt-send') && !document.querySelector('.prompt-send').disabled", "new task can submit");
  await evaluate("document.querySelector('.prompt-send').click()");
  await waitFor("document.querySelector('.md-code-block code')?.textContent.includes('const stream =') && document.querySelector('.new-task-button').disabled", "partial streamed code fence renders before completion");

  await waitFor("document.querySelectorAll('.history-session').length === 3 && document.querySelector('.assistant-message')?.textContent.includes('新会话回答') && !document.querySelector('.new-task-button').disabled", "sending new task retains both older conversations");
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelectorAll('.history-session').length === 3", "renderer reload restores all history");
  await openHistory("历史任务 A", "历史回答 A");
  await waitFor("document.querySelector('.md-content h1') && document.querySelector('.md-content table') && document.querySelector('.md-content blockquote') && document.querySelector('.hljs-keyword')", "renders rich Markdown and highlighted code");
  await waitFor("document.querySelector('.workflow-progress summary')?.textContent.includes('最终评审')", "restores persisted workflow phase");
  await evaluate("document.querySelector('.workflow-progress summary').click()");
  await waitFor("document.querySelector('.workflow-progress').open && document.querySelector('.workflow-progress').textContent.includes('边界条件未处理')", "workflow expands hypothesis and acceptance evidence");
  await evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedText = text; } } });");
  await evaluate("document.querySelector('[aria-label=\"复制代码\"]').click()");
  await waitFor("window.__copiedText?.includes('export function findSession') && !window.__copiedText.includes('```')", "copies code without Markdown fences");
  await evaluate("document.querySelector('[aria-label=\"复制 Markdown\"]').click()");
  await waitFor(`window.__copiedText === ${JSON.stringify(markdownFixture)}`, "copies original Markdown exactly");
  await evaluate("[...document.querySelectorAll('.md-message-actions button')].find(el=>el.textContent.includes('查看原文')).click()");
  await waitFor("document.querySelector('.md-source')?.textContent.includes('# 历史回答 A')", "raw Markdown view");
  await evaluate("[...document.querySelectorAll('.md-message-actions button')].find(el=>el.textContent.includes('查看渲染')).click()");
  await waitFor("document.querySelector('.md-content table') !== null", "switches back to rich rendering");
  await evaluate("document.querySelector('.md-content a[href=\"https://example.com/docs\"]').click()");
  if (openedLink !== "https://example.com/docs") throw new Error("Link did not use desktop bridge");
  checks.push("external links use bridge without navigating the app");
  await evaluate("document.querySelector('.workflow-progress').scrollIntoView({block: 'start', behavior: 'instant'})");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await evaluate("document.querySelector('.conversation').scrollTo({top: 0, behavior: 'instant'})");
  await new Promise(resolve => setTimeout(resolve, 350));
  const screenshot = path.join(scratch, "history.png");
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, screenshot, note: "Real built renderer with fixture IPC; no user database or model calls." }));
  clearTimeout(timer);
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
