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
save("old-a", "历史任务 A", "历史回答 A：已完成分析。");
save("old-b", "历史任务 B", "历史回答 B：保留失败诊断。", "failed");
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
    case "run.start": save(request.params.id, request.params.request, "新会话回答", "completed", request.params.createdAt); return { runId: request.params.id };
    default: return [];
  }
});
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{restoreUnlock:async()=>({ok:true}),request:(request)=>ipcRenderer.invoke('history-fixture',request)});`);
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
  failDetail = true;
  await evaluate("[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes('历史任务 B')).click()");
  await waitFor("document.querySelector('.history-error')?.textContent.includes('无法打开历史记录') && !document.querySelector('.new-task-button').disabled && document.querySelector('.assistant-message')?.textContent.includes('历史回答 A')", "failed restore preserves current view and visible error");
  failDetail = false;
  await evaluate("document.querySelector('.new-task-button').click()");
  await waitFor("document.querySelector('.task-starter') !== null", "new task starter appears");
  await evaluate("document.querySelector('.task-starter').click()");
  await waitFor("document.querySelector('.prompt-send') && !document.querySelector('.prompt-send').disabled", "new task can submit");
  await evaluate("document.querySelector('.prompt-send').click()");

  await waitFor("document.querySelectorAll('.history-session').length === 3 && document.querySelector('.assistant-message')?.textContent.includes('新会话回答') && !document.querySelector('.new-task-button').disabled", "sending new task retains both older conversations");
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelectorAll('.history-session').length === 3", "renderer reload restores all history");
  await openHistory("历史任务 A", "历史回答 A");
  const screenshot = path.join(scratch, "history.png");
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, screenshot, note: "Real built renderer with fixture IPC; no user database or model calls." }));
  clearTimeout(timer);
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
