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
let fixtureProfile = { id: "default", name: "Fixture Developer", allowedProviders: ["openai-compatible"], budget: { maxUsd: 5, maxTurns: 24 }, routeWeights: { quality: 1, cost: 1, latency: 1 }, toolNames: ["read_file", "apply_patch", "terminal", "git_diff"], contextPolicy: { compactAtRatio: 0.7, outputReserveRatio: 0.2 }, verificationPolicy: { items: [], maxRepairAttempts: 2 }, pluginIds: [], sandbox: "local", systemPrompt: "Fixture" };
function save(id, request, text, status = "completed", createdAt = "2026-09-01T00:00:00.000Z") {
  const spec = { id, sessionId: `session-${id}`, request, workspacePath: "D:/fixture-project", profileId: "default", attachments: [], grants: [], budget: {}, createdAt };
  runs.set(id, { spec, status, events: [{ id: `event-${id}`, runId: id, at: createdAt, sequence: 0, type: "result", text, status }] });
}
const markdownFixture = fs.readFileSync(path.join(__dirname, "markdown-fixture.md"), "utf8");
save("old-a", "历史任务 A", markdownFixture);
const workflow = {
  schemaVersion: 2, epoch: "fixture", observationSequence: 10, activity: "git_diff",
  requirementIds: ["req-1"], requirementReceipts: [{ requirementId: "req-1", summary: "测试覆盖目标行为", observationIds: ["diff"], verificationIds: ["verify-local"], diffObservationId: "diff" }],
  localCheck: { status: "passed", revision: 1, epoch: "fixture", runId: "verify-local", reason: "" }, broaderCheck: { status: "skipped", revision: 1, epoch: "fixture", runId: "verify-broader", reason: "可选扩大验证未配置" },
  broaderPolicy: "optional", reviewPolicy: "standard", riskFlags: [], activeChainId: "chain", failureChains: [{ id: "chain", status: "open", count: 1 }],
  phase: "final_review", objective: "检查仓库", intent: "change", requirements: ["修复目标行为"], context: "已检查入口与测试", plan: ["最小修改"],
  hypotheses: [{ cause: "边界条件未处理", evidenceIds: ["read-1"], revision: 1 }], observations: [], verification: [], relevantFiles: ["src/value.ts"], changedFiles: ["src/value.ts"],
  revision: 1, localRevision: 1, broaderRevision: -1, diffRevision: 1, requirementsRevision: 1, reviewedRevision: 1, failures: 5, diagnosisRequired: false, lastFailure: "", requirementEvidence: ["测试通过"], review: "已检查边界条件与修改范围",
};
runs.get("old-a").events[0].sequence = 1;
runs.get("old-a").events.unshift({ id: "workflow-fixture", runId: "old-a", at: "2026-09-01T00:00:00.000Z", sequence: 0, type: "workflow_updated", workflow, detail: "已检查边界条件与修改范围" });
save("old-b", "历史任务 B", "历史回答 B：保留失败诊断。", "failed");
save("old-c", "其他项目任务", "其他项目回答。");
runs.get("old-c").spec.workspacePath = "D:/other-project";
runs.get("old-c").spec.createdAt = "2026-08-01T00:00:00.000Z";
ipcMain.handle("history-fixture", (_event, request) => {
  switch (request.method) {
    case "profiles.list": return [fixtureProfile];
    case "profiles.upsert": fixtureProfile = request.params; return fixtureProfile;
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
  win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false, preload, contextIsolation: true, nodeIntegration: false } });
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
  await waitFor("document.querySelector('.workflow-checks').textContent.includes('局部验证：通过') && document.querySelector('.workflow-checks').textContent.includes('扩大验证：已跳过') && document.querySelector('.workflow-checks').textContent.includes('可选扩大验证未配置')", "workflow distinguishes passed and explicitly skipped verification");
  await waitFor("document.querySelector('.workflow-progress summary').textContent.includes('累计失败 5') && document.querySelector('.workflow-progress summary').textContent.includes('当前故障重复 1 次')", "workflow separates lifetime failures from current chain");
  await waitFor("document.querySelector('.workflow-progress').textContent.includes('业务语义结论由模型评审') && document.querySelector('.workflow-progress').textContent.includes('✓ 修复目标行为')", "workflow shows evidenced requirements and semantic review boundary");
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
  await evaluate("document.querySelector('.sidebar-tools').open = true; [...document.querySelectorAll('.sidebar-tools button')].find(el => el.textContent.trim() === 'Profile').click()");
  await waitFor("document.querySelector('[aria-label=\"扩大验证策略\"]')?.value === 'optional' && document.querySelector('[aria-label=\"独立只读评审\"]')?.value === 'standard'", "verification policy defaults preserve legacy profiles");
  await evaluate("for (const [label, value] of [['扩大验证策略', 'required'], ['独立只读评审', 'risk_based'], ['最多修复次数', '4']]) { const el = document.querySelector('[aria-label=\"' + label + '\"]'); el.value = value; el.dispatchEvent(new Event('change', {bubbles: true})); }");
  await evaluate("[...document.querySelectorAll('button')].find(el => el.textContent.includes('保存验证矩阵')).click()");
  await waitFor("(async()=>{const [p]=await window.harness.request({method:'profiles.list'}); return p.verificationPolicy.broaderPolicy==='required' && p.verificationPolicy.reviewPolicy==='risk_based' && p.verificationPolicy.maxRepairAttempts===4;})()", "verification policy and repair limit persist through IPC");
  const settingsScreenshot = path.join(scratch, "verification-settings.png");
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.writeFileSync(settingsScreenshot, (await win.webContents.capturePage()).toPNG());
  await openHistory("历史任务 A", "历史回答 A");
  await new Promise(resolve => setTimeout(resolve, 700));
  await evaluate("document.querySelector('.workflow-progress').open = true");
  await evaluate("document.querySelector('.workflow-progress').scrollIntoView({block: 'start', behavior: 'instant'})");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await evaluate("document.querySelector('.conversation').scrollTo({top: 0, behavior: 'instant'})");
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitFor("document.querySelector('.workflow-progress').getBoundingClientRect().top >= 0 && document.querySelector('.conversation').scrollTop === 0", "workflow panel is visible for screenshot review");
  // Hidden Windows windows can retain a stale compositor frame after scrolling.
  win.setSize(1401, 1000);
  await new Promise(resolve => setTimeout(resolve, 350));
  const screenshot = path.join(scratch, "history.png");
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, screenshot, settingsScreenshot, note: "Real built renderer with fixture IPC; no user database or model calls." }));
  clearTimeout(timer);
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
