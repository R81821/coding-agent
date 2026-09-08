// Run after the desktop build. Uses fixture IPC and isolated userData only.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(root, ".cache/session-ui-"));
app.setPath("userData", path.join(scratch, "profile"));
app.disableHardwareAcceleration();

const at = "2026-09-01T00:00:00.000Z";
const runs = new Map();
const sessions = new Map();
const projects = new Map([
  ["project-main", { id: "project-main", workspacePath: "D:/fixture-project", createdAt: at, updatedAt: at }],
  ["project-other", { id: "project-other", workspacePath: "D:/other-project", createdAt: at, updatedAt: at }],
]);
const memories = [{ id: "memory-preserved", content: "must survive Session purge" }];
let failDetail = false;
let fixtureProfile = { id: "default", name: "Fixture Developer", allowedProviders: ["openai-compatible"], budget: { maxUsd: 5, maxTurns: 24 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, toolNames: ["read_file", "apply_patch", "terminal", "git_diff"], contextPolicy: { compactAtRatio: 0.7, outputReserveRatio: 0.2 }, verificationPolicy: { items: [], maxRepairAttempts: 2 }, pluginIds: [], sandbox: "local", systemPrompt: "Fixture" };

function createSession(id, title, workspacePath, updatedAt = at) {
  const record = { id, title, workspacePath, profileId: "default", createdAt: updatedAt, updatedAt };
  sessions.set(id, record);
  return record;
}
function saveRun(id, sessionId, request, text, status = "completed", createdAt = at) {
  const session = sessions.get(sessionId);
  const spec = { id, sessionId, request, workspacePath: session.workspacePath, profileId: "default", attachments: [], grants: [], budget: {}, createdAt };
  runs.set(id, { spec, status, events: [{ id: `event-${id}`, runId: id, at: createdAt, sequence: 0, type: "result", text, status }] });
}
function sessionRuns(sessionId) {
  return [...runs.values()].filter((run) => run.spec.sessionId === sessionId).sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt) || a.spec.id.localeCompare(b.spec.id));
}
function sessionSummary(session) {
  const owned = sessionRuns(session.id);
  const latest = owned.at(-1);
  return { ...session, runCount: owned.length, ...(latest ? { latestRunId: latest.spec.id, latestStatus: latest.status } : {}) };
}

createSession("session-a", "历史任务 A", "D:/fixture-project", "2026-09-03T00:00:00.000Z");
createSession("session-b", "历史任务 B", "D:/fixture-project", "2026-09-02T00:00:00.000Z");
createSession("session-c", "其他项目任务", "D:/other-project", "2026-08-01T00:00:00.000Z");
const markdownFixture = fs.readFileSync(path.join(__dirname, "markdown-fixture.md"), "utf8");
saveRun("old-a", "session-a", "历史任务 A", markdownFixture);
saveRun("old-b", "session-b", "历史任务 B", "历史回答 B：保留失败诊断。", "failed");
saveRun("old-c", "session-c", "其他项目任务", "其他项目回答。", "completed", "2026-08-01T00:00:00.000Z");
const workflow = { schemaVersion: 2, epoch: "fixture", observationSequence: 10, activity: "git_diff", requirementIds: ["req-1"], requirementReceipts: [{ requirementId: "req-1", summary: "测试覆盖目标行为", observationIds: ["diff"], verificationIds: ["verify-local"], diffObservationId: "diff" }], localCheck: { status: "passed", revision: 1, epoch: "fixture", runId: "verify-local", reason: "" }, broaderCheck: { status: "skipped", revision: 1, epoch: "fixture", runId: "verify-broader", reason: "可选扩大验证未配置" }, broaderPolicy: "optional", reviewPolicy: "standard", riskFlags: [], activeChainId: "chain", failureChains: [{ id: "chain", status: "open", count: 1 }], phase: "final_review", objective: "检查仓库", intent: "change", requirements: ["修复目标行为"], context: "已检查入口与测试", plan: ["最小修改"], hypotheses: [{ cause: "边界条件未处理", evidenceIds: ["read-1"], revision: 1 }], observations: [], verification: [], relevantFiles: ["src/value.ts"], changedFiles: ["src/value.ts"], revision: 1, localRevision: 1, broaderRevision: -1, diffRevision: 1, requirementsRevision: 1, reviewedRevision: 1, failures: 5, diagnosisRequired: false, lastFailure: "", requirementEvidence: ["测试通过"], review: "已检查边界条件与修改范围" };
runs.get("old-a").events[0].sequence = 1;
runs.get("old-a").events.unshift({ id: "workflow-fixture", runId: "old-a", at, sequence: 0, type: "workflow_updated", workflow, detail: "已检查边界条件与修改范围" });

ipcMain.handle("session-fixture", (_event, request) => {
  switch (request.method) {
    case "profiles.list": return [fixtureProfile];
    case "profiles.upsert": fixtureProfile = request.params; return fixtureProfile;
    case "sessions.create": sessions.set(request.params.id, request.params); return request.params;
    case "sessions.list": {
      const deleted = request.params?.deleted ?? false;
      const visibleProjects = new Set([...projects.values()].filter((project) => !project.deletedAt).map((project) => project.workspacePath.toLowerCase()));
      const items = [...sessions.values()].filter((session) => Boolean(session.deletedAt) === deleted).filter((session) => deleted || visibleProjects.has(session.workspacePath.toLowerCase())).map(sessionSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = request.params?.offset ?? 0; const limit = request.params?.limit ?? 50;
      return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit };
    }
    case "session.get": {
      if (failDetail) throw new Error("fixture detail unavailable");
      const session = sessions.get(request.params.sessionId);
      return session && { session, runs: sessionRuns(session.id).map((run) => ({ spec: run.spec, status: run.status, events: run.events })) };
    }
    case "session.delete": { const session = sessions.get(request.params.sessionId); sessions.set(session.id, { ...session, deletedAt: new Date().toISOString() }); return sessions.get(session.id); }
    case "session.restore": { const session = { ...sessions.get(request.params.sessionId) }; delete session.deletedAt; sessions.set(session.id, session); return session; }
    case "session.purge": { const sessionId = request.params.sessionId; for (const [id, run] of runs) if (run.spec.sessionId === sessionId) runs.delete(id); sessions.delete(sessionId); return { sessionId }; }
    case "projects.list": return [...projects.values()].filter((project) => Boolean(project.deletedAt) === (request.params?.deleted ?? false));
    case "project.delete": { const project = projects.get(request.params.projectId); projects.set(project.id, { ...project, deletedAt: new Date().toISOString() }); return projects.get(project.id); }
    case "project.restore": { const project = { ...projects.get(request.params.projectId) }; delete project.deletedAt; projects.set(project.id, project); return project; }
    case "run.get": { const run = runs.get(request.params.runId); return run && { spec: run.spec, status: run.status }; }
    case "run.events": return (runs.get(request.params.runId)?.events ?? []).filter((event) => event.sequence > request.params.afterSequence);
    case "run.start": {
      const session = sessions.get(request.params.sessionId);
      if (!session || session.deletedAt) throw new Error("invalid Session");
      const project = [...projects.values()].find((item) => item.workspacePath === session.workspacePath);
      if (!project || project.deletedAt) throw new Error("invalid project");
      const id = request.params.id;
      const spec = request.params;
      runs.set(id, { spec, status: "running", events: [{ id: `delta-${id}`, runId: id, at: spec.createdAt, sequence: 0, type: "text_delta", delta: `# 第 ${sessionRuns(session.id).length + 1} 轮回答\n\n\`\`\`js\nconst stream =` }] });
      sessions.set(session.id, { ...session, title: session.title === "新会话" ? spec.request : session.title, updatedAt: spec.createdAt });
      setTimeout(() => { const run = runs.get(id); const text = `${run.events[0].delta} 42;\n\`\`\``; run.events.push({ id: `result-${id}`, runId: id, at: spec.createdAt, sequence: 1, type: "result", text, status: "completed" }); run.status = "completed"; }, 500);
      return { runId: id };
    }
    case "memory.list": return memories;
    case "fixture.stats": return { sessions: sessions.size, runs: runs.size, memories: memories.length, runSessionIds: [...runs.values()].slice(-2).map((run) => run.spec.sessionId) };
    default: return [];
  }
});

let openedLink;
ipcMain.handle("history-open-link", (_event, url) => { openedLink = url; });
const preload = path.join(scratch, "preload.cjs");
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('harness',{restoreUnlock:async()=>({ok:true}),openExternal:async(url)=>ipcRenderer.invoke('history-open-link',url),request:(request)=>ipcRenderer.invoke('session-fixture',request),chooseWorkspace:async()=> 'D:/fixture-project',chooseImages:async()=>[],putImage:async()=>{},captureScreen:async()=>({}),credentialStatus:async()=>({}),providerSettings:async()=>({openaiCompatibleBaseUrl:'',openaiCompatibleModel:''}),setCredential:async()=>({}),deleteCredential:async()=>({}),setProviderSettings:async settings=>settings});`);
let win;
const checks = [];
const evaluate = (code) => win.webContents.executeJavaScript(code);
async function waitFor(code, label) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await evaluate(code)) { checks.push(label); return; } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}`); }
async function openSession(title, answer) { await evaluate(`[...document.querySelectorAll('.history-session')].find(el=>el.textContent.includes(${JSON.stringify(title)})).click()`); await waitFor(`document.querySelector('.assistant-message')?.textContent.includes(${JSON.stringify(answer)}) && !document.querySelector('.new-task-button').disabled`, `restore ${title}`); }
const timer = setTimeout(() => { console.error("Session UI smoke timeout"); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false, preload, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(root, "apps/desktop/dist/index.html"));
  await waitFor("document.querySelectorAll('.history-session').length === 2", "Sessions load as project children");
  await openSession("历史任务 A", "历史回答 A");
  await evaluate("document.querySelector('.new-task-button').click()");
  await waitFor("document.querySelectorAll('.history-session').length === 3 && document.querySelector('.task-starter')", "new task creates one empty Session");
  await evaluate("document.querySelector('.task-starter').click()");
  await waitFor("!document.querySelector('.prompt-send').disabled", "starter fills first prompt");
  await evaluate("document.querySelector('.prompt-send').click()");
  await waitFor("document.querySelector('.assistant-message')?.textContent.includes('第 1 轮回答') && document.querySelectorAll('.history-session').length === 3 && !document.querySelector('.new-task-button').disabled", "first send stays in created Session");
  await evaluate(`(()=>{const el=document.querySelector('.prompt-textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'继续第二轮');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("!document.querySelector('.prompt-send').disabled", "second prompt is ready");
  await evaluate("document.querySelector('.prompt-send').click()");
  await waitFor("document.querySelectorAll('.conversation-turn').length === 2 && document.querySelectorAll('.history-session').length === 3 && !document.querySelector('.new-task-button').disabled", "ordinary send appends a turn without creating a Session");
  await waitFor("(async()=>{const s=await window.harness.request({method:'fixture.stats'});return s.runSessionIds.length===2&&s.runSessionIds[0]===s.runSessionIds[1]&&s.memories===1})()", "two runs share one Session and memory remains");

  await evaluate("window.confirm=()=>true; [...document.querySelectorAll('.session-delete')].find(el=>el.getAttribute('aria-label').includes('历史任务 B')).click()");
  await waitFor("document.querySelectorAll('.history-session').length === 2", "soft-deleted Session leaves sidebar");
  await evaluate("document.querySelector('.sidebar-settings').click()");
  await waitFor("document.querySelector('.deleted-session')?.textContent.includes('历史任务 B')", "Settings lists deleted Session");
  await waitFor("document.querySelector('.deleted-session .restore-session') && document.querySelector('.deleted-session .purge-session')", "deleted Session offers restore and permanent delete");
  await evaluate("document.querySelector('.deleted-session .restore-session').click()");
  await waitFor("!document.querySelector('.deleted-session') && document.querySelectorAll('.history-session').length === 3", "restoring Session returns it to project");

  await evaluate("[...document.querySelectorAll('.project-delete')].find(el=>el.getAttribute('aria-label').includes('other-project')).click()");
  await waitFor("document.querySelectorAll('.project-group').length === 1", "project soft delete hides only Harness project");
  await evaluate("document.querySelector('.sidebar-settings').click()");
  await waitFor("document.querySelector('.deleted-project')?.textContent.includes('other-project') && !document.querySelector('.deleted-project .purge-session')", "deleted project offers restore only");
  await evaluate("document.querySelector('.deleted-project .restore-project').click()");
  await waitFor("document.querySelectorAll('.project-group').length === 2", "restoring project returns its Sessions");

  await evaluate("[...document.querySelectorAll('.session-delete')].find(el=>el.getAttribute('aria-label').includes('历史任务 B')).click(); document.querySelector('.sidebar-settings').click()");
  await waitFor("document.querySelector('.deleted-session')?.textContent.includes('历史任务 B')", "Session returns to recycle bin");
  await evaluate("document.querySelector('.deleted-session .purge-session').click()");
  await waitFor("!document.querySelector('.deleted-session')", "permanent delete removes Session history");
  await waitFor("(async()=>{const s=await window.harness.request({method:'fixture.stats'});return s.memories===1})()", "Session purge preserves memory");

  await openSession("历史任务 A", "历史回答 A");
  await waitFor("document.querySelector('.md-content h1') && document.querySelector('.md-content table') && document.querySelector('.hljs-keyword')", "restored Session renders rich Markdown");
  await waitFor("document.querySelector('.workflow-progress summary')?.textContent.includes('最终评审')", "restored Session keeps workflow state");
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedText=text}}});document.querySelector('[aria-label=\"复制代码\"]').click()");
  await waitFor("window.__copiedText?.includes('export function findSession')", "Markdown code copy still works");
  await evaluate("document.querySelector('.md-content a[href=\"https://example.com/docs\"]').click()");
  if (openedLink !== "https://example.com/docs") throw new Error("Link did not use desktop bridge");
  checks.push("external links still use desktop bridge");

  const screenshot = path.join(scratch, "sessions.png");
  win.setSize(1401, 1000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('.sidebar-settings').click()");
  await waitFor("document.querySelector('.recycle-bin') && document.querySelector('main h1')?.textContent === '设置'", "Settings recycle layout is visible for screenshot review");
  win.setSize(1400, 1000);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const settingsScreenshot = path.join(scratch, "recycle-bin.png");
  fs.writeFileSync(settingsScreenshot, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, screenshot, settingsScreenshot, note: "Real built renderer with fixture IPC; no user database, model, network, or workspace deletion." }));
  clearTimeout(timer); win.destroy(); app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
