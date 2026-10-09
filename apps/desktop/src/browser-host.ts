import { createServer, type Server } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { app, BrowserWindow, WebContentsView, session, safeStorage, dialog, type DownloadItem, type WebContents } from "electron";
import { BrowserActionSchema, BrowserBridgeRequestSchema, browserUrl, type BrowserAction, type BrowserState, type BrowserTabState, type BrowserDownloadState, type BrowserLayout } from "@harness/protocol";
import type { ToolResult } from "@harness/tools";
import { browserPartition, browserUploadPaths, reserveBrowserDownload } from "./browser-files.js";

interface Tab { state: BrowserTabState; view: WebContentsView; busy: boolean; pendingDownload?: { state: BrowserDownloadState; timer: NodeJS.Timeout } }
interface Conversation { state: BrowserState; tabs: Map<string, Tab>; workspace: string; ready: Promise<void>; items: Map<string, DownloadItem>; saves: Promise<void> }
interface Context { workspacePath: string }
type Resolver = (sessionId: string, runId?: string) => Promise<Context>;

export class DesktopBrowserHost {
  readonly token = randomBytes(32).toString("hex");
  readonly endpoint = process.platform === "win32" ? `\\\\.\\pipe\\harness-browser-${randomUUID()}` : join(app.getPath("temp"), `harness-browser-${randomUUID()}.sock`);
  private server?: Server;
  private window?: BrowserWindow;
  private readonly conversations = new Map<string, Conversation>();
  private readonly runTabs = new Map<string, string>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private layout: BrowserLayout = { sessionId: null, visible: false, obscured: false, x: 0, y: 0, width: 0, height: 0 };
  constructor(private readonly resolveContext: Resolver) {}

  async listen(): Promise<void> {
    this.server = createServer(socket => {
      const controller = new AbortController(); this.controllers.add(controller);
      let buffer = "", started = false;
      socket.setEncoding("utf8"); socket.setTimeout(65_000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("close", () => { controller.abort(); this.controllers.delete(controller); });
      socket.on("data", (chunk: string) => {
        if (started) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1_000_000) { socket.destroy(); return; }
        const end = buffer.indexOf("\n"); if (end < 0) return; started = true;
        void (async () => {
          try {
            const request = BrowserBridgeRequestSchema.parse(JSON.parse(buffer.slice(0, end)));
            if (request.token !== this.token) throw new Error("无效的浏览器连接");
            const context = await this.resolveContext(request.sessionId, request.runId);
            const result = await this.execute(request.sessionId, request.input, context, controller.signal, request.runId);
            socket.end(JSON.stringify({ ok: true, result }) + "\n");
          } catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "浏览器操作失败" }) + "\n"); }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.endpoint, resolve); });
  }
  attach(window: BrowserWindow): void { this.window = window; window.on("resize", () => this.applyLayout()); }
  async state(sessionId: string): Promise<BrowserState> { const context = await this.resolveContext(sessionId); return (await this.getConversation(sessionId, context)).state; }
  async manual(sessionId: string, input: unknown): Promise<ToolResult> {
    const action = BrowserActionSchema.parse(input);
    const context = await this.resolveContext(sessionId);
    if (action.action === "download") {
      const result = await dialog.showMessageBox(this.window!, { type: "question", message: "保存此下载到项目 downloads 文件夹？", detail: `${action.url}\n${context.workspacePath}`, buttons: ["保存", "取消"], defaultId: 0, cancelId: 1 });
      if (result.response !== 0) throw new Error("已取消下载");
    }
    return this.execute(sessionId, action, context, new AbortController().signal);
  }
  setLayout(layout: BrowserLayout): void {
    this.layout = layout;
    const current = layout.sessionId && this.conversations.get(layout.sessionId);
    if (current) current.state.visible = layout.visible;
    this.applyLayout();
  }
  private applyLayout(): void {
    const win = this.window; if (!win || win.isDestroyed()) return;
    const zoom = win.webContents.getZoomFactor(), bounds = win.getContentBounds();
    const x = Math.max(0, Math.min(bounds.width, Math.round(this.layout.x * zoom)));
    const y = Math.max(42, Math.min(bounds.height, Math.round(this.layout.y * zoom)));
    for (const [id, conversation] of this.conversations) for (const tab of conversation.tabs.values()) {
      const visible = id === this.layout.sessionId && tab.state.id === conversation.state.activeTabId && tab.state.url !== "about:blank" && this.layout.visible && !this.layout.obscured && this.layout.width > 0 && this.layout.height > 0;
      if (visible) tab.view.setBounds({ x, y, width: Math.max(1, Math.min(bounds.width - x, Math.round(this.layout.width * zoom))), height: Math.max(1, Math.min(bounds.height - y, Math.round(this.layout.height * zoom))) });
      tab.view.setVisible(visible);
    }
  }
  private publish(conversation: Conversation): void {
    conversation.state.tabs = [...conversation.tabs.values()].map(tab => ({ ...tab.state }));
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send("harness:browser-state", conversation.state);
    this.applyLayout();
  }
  private metadataPath(id: string): string { return join(app.getPath("userData"), "browser-tabs", browserPartition(id).slice(8) + ".bin"); }
  private save(conversation: Conversation): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const payload = JSON.stringify({ urls: [...conversation.tabs.values()].map(tab => tab.state.url), activeIndex: [...conversation.tabs.keys()].indexOf(conversation.state.activeTabId ?? "") });
    conversation.saves = conversation.saves.catch(() => {}).then(async () => {
      const path = this.metadataPath(conversation.state.sessionId); await mkdir(join(app.getPath("userData"), "browser-tabs"), { recursive: true });
      await writeFile(path, safeStorage.encryptString(payload));
    }).catch(() => {});
  }
  private async getConversation(id: string, context: Context): Promise<Conversation> {
    let conversation = this.conversations.get(id);
    if (!conversation) {
      conversation = { state: { sessionId: id, tabs: [], downloads: [], visible: false, revealVersion: 0 }, tabs: new Map(), items: new Map(), workspace: context.workspacePath, ready: Promise.resolve(), saves: Promise.resolve() };
      this.conversations.set(id, conversation);
      const current = conversation;
      const partition = session.fromPartition(browserPartition(id));
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      partition.on("will-download", (event, item, contents) => {
        const tab = [...current.tabs.values()].find(candidate => candidate.view.webContents === contents);
        if (!tab) { event.preventDefault(); return; }
        const pending = tab.pendingDownload;
        // Compare against the whole chain: getURLChain()[0] is the pre-redirect URL, so a redirected
        // download would never match its own reservation and would be reported as a second, unrelated
        // one for the user to confirm again.
        if (!pending || !item.getURLChain().includes(pending.state.url)) {
          current.state.downloads.unshift({ id: randomUUID(), tabId: tab.state.id, url: item.getURL(), filename: item.getFilename(), status: "awaiting_confirmation", receivedBytes: 0, totalBytes: item.getTotalBytes() });
          event.preventDefault();
          current.state.visible = true; current.state.revealVersion++;
          current.state.downloads = current.state.downloads.slice(0, 100); this.publish(current); return;
        }
        clearTimeout(pending.timer); delete tab.pendingDownload;
        const record = pending.state;
        item.setSavePath(record.path!); current.items.set(record.id, item);
        const update = () => { record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); this.publish(current); };
        item.on("updated", update);
        item.once("done", (_event, status) => {
          record.status = status; update(); current.items.delete(record.id);
          if (status !== "completed" && record.path) void rm(record.path, { force: true });
        });
        update();
      });
      current.ready = (async () => {
        try {
          const saved = JSON.parse(safeStorage.decryptString(await readFile(this.metadataPath(id)))) as { urls?: unknown; activeIndex?: number };
          if (Array.isArray(saved.urls)) for (const url of saved.urls.slice(0, 20)) if (typeof url === "string") { try { this.createTab(current, browserUrl(url)); } catch { /* Ignore obsolete URLs. */ } }
          const selected = [...current.tabs.keys()][saved.activeIndex ?? 0]; if (selected) current.state.activeTabId = selected;
        } catch { /* First use, or metadata is unavailable. Cookies remain in the partition. */ }
      })();
    }
    await conversation.ready; conversation.workspace = context.workspacePath; return conversation;
  }
  private createTab(conversation: Conversation, url = "about:blank", load = true, adoptedWebContents?: WebContents): Tab {
    if (!this.window || this.window.isDestroyed()) throw new Error("桌面浏览器窗口不可用");
    if (conversation.tabs.size >= 20) throw new Error("每个对话最多打开 20 个标签页，请先关闭不用的标签");
    const view = new WebContentsView(adoptedWebContents
      ? { webContents: adoptedWebContents }
      : { webPreferences: { partition: browserPartition(conversation.state.sessionId), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const tab: Tab = { state: { id: randomUUID(), title: "新标签页", url, loading: false, canGoBack: false, canGoForward: false }, view, busy: false };
    conversation.tabs.set(tab.state.id, tab); conversation.state.activeTabId = tab.state.id;
    this.window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 640, height: 700 }); view.setVisible(false);
    const contents = view.webContents;
    const update = () => {
      if (contents.isDestroyed()) return;
      tab.state.url = contents.getURL() || url; tab.state.title = contents.getTitle() || (tab.state.url === "about:blank" ? "新标签页" : tab.state.url);
      tab.state.loading = contents.isLoading(); tab.state.canGoBack = contents.navigationHistory.canGoBack(); tab.state.canGoForward = contents.navigationHistory.canGoForward();
      this.publish(conversation);
    };
    contents.on("did-start-loading", () => { delete tab.state.error; update(); });
    contents.on("did-stop-loading", update);
    contents.on("page-title-updated", update);
    contents.on("did-navigate", () => { update(); this.save(conversation); });
    contents.on("did-navigate-in-page", () => { update(); this.save(conversation); });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { tab.state.error = description; update(); } });
    contents.on("render-process-gone", () => { tab.state.error = "网页进程已退出，请刷新"; tab.state.loading = false; this.publish(conversation); });
    const restrict = (event: Electron.Event, target: string) => { try { browserUrl(target); } catch { event.preventDefault(); } };
    contents.on("will-navigate", restrict); contents.on("will-redirect", restrict);
    contents.setWindowOpenHandler(details => {
      try { browserUrl(details.url || "about:blank"); } catch { return { action: "deny" }; }
      if (conversation.tabs.size >= 20) return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: options => {
          // Electron 37 supplies a guest WebContents for foreground popups. It must be adopted by
          // the returned WebContentsView; returning an independently-created contents triggers
          // Electron's "connected to webContents passed with options" exception.
          const supplied = (options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
          const tab = this.createTab(conversation, details.url || "about:blank", !supplied, supplied);
          return tab.view.webContents;
        }
      };
    });
    if (load && url !== "about:blank") void contents.loadURL(url).catch(() => {});
    this.publish(conversation); return tab;
  }
  private target(conversation: Conversation, input: BrowserAction, runId?: string): Tab {
    const explicit = "tabId" in input ? input.tabId : undefined;
    let id = explicit ?? (runId ? this.runTabs.get(runId) : undefined) ?? conversation.state.activeTabId;
    if (!id && ["navigate", "snapshot", "screenshot"].includes(input.action)) id = this.createTab(conversation).state.id;
    const tab = id ? conversation.tabs.get(id) : undefined;
    if (!tab) throw new Error("标签页不存在，请先调用 tabs 或 new_tab");
    if (runId) this.runTabs.set(runId, tab.state.id);
    return tab;
  }
  private async evaluate(tab: Tab, expression: string): Promise<unknown> {
    const debuggerApi = tab.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const result = await debuggerApi.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "网页操作失败");
    return result.result?.value;
  }
  private async waitForLoad(tab: Tab, signal: AbortSignal): Promise<void> {
    const contents = tab.view.webContents;
    if (!contents.isLoading()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); contents.removeListener("did-stop-loading", loaded); signal.removeEventListener("abort", aborted); };
      const loaded = () => { finish(); resolve(); };
      const aborted = () => { finish(); reject(new Error("浏览器操作已取消")); };
      const timer = setTimeout(() => { finish(); reject(new Error("网页仍在加载，请等待后重试")); }, 30_000);
      contents.once("did-stop-loading", loaded); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  async execute(id: string, input: BrowserAction, context: Context, signal: AbortSignal, runId?: string): Promise<ToolResult> {
    signal.throwIfAborted();
    const conversation = await this.getConversation(id, context); signal.throwIfAborted();
    if (input.action === "tabs") return { output: conversation.state };
    if (input.action === "downloads") return { output: { downloads: conversation.state.downloads.map(item => ({ ...item, ...(item.path ? { path: relative(conversation.workspace, item.path) } : {}) })) } };
    if (input.action === "cancel_download") {
      const item = conversation.items.get(input.downloadId); if (item) item.cancel();
      else for (const tab of conversation.tabs.values()) if (tab.pendingDownload?.state.id === input.downloadId) {
        clearTimeout(tab.pendingDownload.timer); const record = tab.pendingDownload.state; delete tab.pendingDownload; record.status = "cancelled"; if (record.path) await rm(record.path, { force: true }); this.publish(conversation);
      }
      return { output: { cancelled: true } };
    }
    if (input.action === "new_tab") {
      const tab = this.createTab(conversation, browserUrl(input.url ?? "about:blank")); if (runId) this.runTabs.set(runId, tab.state.id);
      conversation.state.visible = true; conversation.state.revealVersion++; this.publish(conversation); this.save(conversation); return { output: { tabId: tab.state.id, ...tab.state } };
    }
    const tab = this.target(conversation, input, runId);
    if (tab.busy) throw new Error("此标签页正在执行另一项浏览器操作，请稍后重试");
    if (input.action === "switch_tab") { conversation.state.activeTabId = tab.state.id; conversation.state.visible = true; conversation.state.revealVersion++; this.publish(conversation); this.save(conversation); return { output: { tabId: tab.state.id } }; }
    if (input.action === "close_tab") { this.closeTab(conversation, tab); return { output: { closed: true } }; }
    conversation.state.visible = true; conversation.state.revealVersion++; conversation.state.activeTabId = tab.state.id; this.publish(conversation);
    tab.busy = true;
    const contents = tab.view.webContents;
    const abort = () => { if (!contents.isDestroyed()) { contents.stop(); if (contents.debugger.isAttached()) void contents.debugger.sendCommand("Runtime.terminateExecution").catch(() => {}); } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (["snapshot", "screenshot", "click", "fill", "upload", "scroll", "press_key"].includes(input.action)) await this.waitForLoad(tab, signal);
      signal.throwIfAborted();
      let output: unknown;
      switch (input.action) {
        case "navigate": await contents.loadURL(browserUrl(input.url)); break;
        case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
        case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
        case "reload": contents.reload(); break;
        case "screenshot": {
          const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          output = { mimeType: "image/png", base64: image.toPNG().toString("base64") }; break;
        }
        case "snapshot": output = await this.evaluate(tab, `(() => {
          const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(el => el.getClientRects().length).slice(0,200);
          const selector = el => { if(el.id) return '#'+CSS.escape(el.id); const parts=[]; while(el && el !== document.documentElement){ const parent=el.parentElement; if(!parent)break; parts.unshift(el.localName+':nth-child('+([...parent.children].indexOf(el)+1)+')'); el=parent; } return 'html > '+parts.join(' > '); };
          return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,60000),truncated:(document.body?.innerText||'').length>60000,elements:nodes.map(el=>({selector:selector(el),tag:el.localName,type:el.getAttribute('type'),text:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').slice(0,200)}))};
        })()`); break;
        case "click": case "fill": {
          const selector = JSON.stringify(input.selector);
          const action = input.action === "click" ? "el.click();" : `if(!['INPUT','TEXTAREA','SELECT'].includes(el.tagName))throw Error('目标不是表单输入框'); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(input.value)}); el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));`;
          await this.evaluate(tab, `(() => {const nodes=document.querySelectorAll(${selector}); if(nodes.length!==1)throw Error('选择器必须匹配一个元素，当前匹配 '+nodes.length);const el=nodes[0];el.scrollIntoView({block:'center'});el.focus();${action} return true;})()`); break;
        }
        case "press_key": contents.sendInputEvent({ type: "keyDown", keyCode: input.key === "Space" ? " " : input.key }); contents.sendInputEvent({ type: "keyUp", keyCode: input.key === "Space" ? " " : input.key }); break;
        case "scroll": await this.evaluate(tab, `window.scrollBy(${input.x},${input.y})`); break;
        case "upload": {
          const files = await browserUploadPaths(context.workspacePath, input.paths); signal.throwIfAborted();
          if (browserUrl(input.url) !== contents.getURL()) throw new Error("网页地址已改变，请重新读取页面并确认上传目标");
          const debug = contents.debugger; if (!debug.isAttached()) debug.attach("1.3");
          const { root } = await debug.sendCommand("DOM.getDocument");
          const { nodeIds } = await debug.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: input.selector });
          if (nodeIds.length !== 1) throw new Error("上传选择器必须匹配一个文件输入框");
          await debug.sendCommand("DOM.setFileInputFiles", { nodeId: nodeIds[0], files }); output = { uploaded: input.paths }; break;
        }
        case "download": {
          if (tab.pendingDownload) throw new Error("此标签页正在启动另一项下载");
          const url = browserUrl(input.url, true);
          if (url.startsWith("blob:") && new URL(url.slice(5)).origin !== new URL(tab.state.url).origin) throw new Error("Blob 下载必须属于当前网页");
          const path = await reserveBrowserDownload(context.workspacePath, input.filename ?? decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "download"));
          if (signal.aborted) { await rm(path, { force: true }); signal.throwIfAborted(); }
          const record: BrowserDownloadState = { id: randomUUID(), tabId: tab.state.id, url, filename: basename(path), path, status: "progressing", receivedBytes: 0, totalBytes: 0 };
          conversation.state.downloads = conversation.state.downloads.filter(item => !(item.status === "awaiting_confirmation" && item.tabId === tab.state.id && item.url === url));
          conversation.state.downloads.unshift(record);
          const timer = setTimeout(() => { if (tab.pendingDownload?.state.id === record.id) { delete tab.pendingDownload; record.status = "interrupted"; record.error = "下载未开始"; void rm(path, { force: true }); this.publish(conversation); } }, 30_000);
          tab.pendingDownload = { state: record, timer };
          contents.downloadURL(url);
          output = { downloadId: record.id, path: relative(context.workspacePath, path), status: record.status, message: "下载已请求，调用 downloads 确认完成" }; break;
        }
      }
      signal.throwIfAborted(); this.save(conversation);
      return { output: { tabId: tab.state.id, url: contents.getURL(), title: contents.getTitle(), ...(output && typeof output === "object" ? output : { success: true }) } };
    } finally { signal.removeEventListener("abort", abort); tab.busy = false; this.publish(conversation); }
  }
  private closeTab(conversation: Conversation, tab: Tab): void {
    for (const record of conversation.state.downloads.filter(item => item.tabId === tab.state.id)) conversation.items.get(record.id)?.cancel();
    if (tab.pendingDownload) { clearTimeout(tab.pendingDownload.timer); tab.pendingDownload.state.status = "cancelled"; const path = tab.pendingDownload.state.path; if (path) void rm(path, { force: true }); }
    this.window?.contentView.removeChildView(tab.view); tab.view.webContents.close(); conversation.tabs.delete(tab.state.id);
    if (conversation.state.activeTabId === tab.state.id) { delete conversation.state.activeTabId; const next = [...conversation.tabs.keys()].at(-1); if (next) conversation.state.activeTabId = next; }
    this.publish(conversation); this.save(conversation);
  }
  async purge(id: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) { for (const tab of [...conversation.tabs.values()]) this.closeTab(conversation, tab); await conversation.saves; this.conversations.delete(id); }
    const partition = session.fromPartition(browserPartition(id)); await partition.clearStorageData(); await partition.clearCache();
    await rm(this.metadataPath(id), { force: true });
  }
  close(): void {
    // before-quit runs again after the daemon finishes stopping. Electron may have
    // released a view's webContents by then, so never dispose the same host twice.
    if (this.closed) return;
    this.closed = true;
    this.server?.close(); delete this.server;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    const conversations = [...this.conversations.values()];
    this.conversations.clear(); this.runTabs.clear(); delete this.window;
    for (const conversation of conversations) {
      for (const item of conversation.items.values()) item.cancel();
      for (const tab of conversation.tabs.values()) {
        if (tab.pendingDownload) {
          clearTimeout(tab.pendingDownload.timer);
          const record = tab.pendingDownload.state; delete tab.pendingDownload; record.status = "cancelled";
          if (record.path) void rm(record.path, { force: true });
        }
        const contents = tab.view.webContents;
        if (contents && !contents.isDestroyed()) contents.close();
      }
    }
    if (process.platform !== "win32") void rm(this.endpoint, { force: true });
  }
}
