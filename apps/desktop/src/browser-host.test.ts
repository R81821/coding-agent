import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ToolContext } from "../../../packages/tools/src/types.js";
import { desktopBrowserRequest } from "../../../packages/tools/src/browser-bridge.js";

const mock = vi.hoisted(() => ({ views: [] as unknown[], partitions: new Map<string, unknown>(), root: "" }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Contents extends EventEmitter {
    url = ""; destroyed = false; loading = false;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    debugger = { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async () => ({ result: { value: { text: "fixture" } } })) };
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    getTitle() { return this.url; }
    isLoading() { return this.loading; }
    async loadURL(url: string) { this.url = url; this.emit("did-navigate"); }
    stop = vi.fn(() => { this.loading = false; this.emit("did-stop-loading"); });
    close() { this.destroyed = true; }
    setWindowOpenHandler = vi.fn();
    downloadURL = vi.fn();
  }
  class View {
    webContents: Contents; visible = false; bounds = {};
    constructor(readonly options: { webPreferences?: { partition: string }; webContents?: Contents }) { this.webContents = options.webContents ?? new Contents(); mock.views.push(this); }
    setVisible(value: boolean) { this.visible = value; }
    setBounds(value: object) { this.bounds = value; }
  }
  return {
    app: { getPath: () => mock.root }, BrowserWindow: class {}, WebContentsView: View,
    safeStorage: { isEncryptionAvailable: () => false, decryptString: () => "{}" },
    session: { fromPartition: (key: string) => {
      if (!mock.partitions.has(key)) mock.partitions.set(key, Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }));
      return mock.partitions.get(key);
    } }, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }
  };
});
import { DesktopBrowserHost } from "./browser-host.js";

type View = { visible: boolean; options: { webPreferences?: { partition: string } }; webContents: EventEmitter & { loading: boolean; stop: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn>; debugger: { sendCommand: ReturnType<typeof vi.fn> }; getURL(): string } };
let host: DesktopBrowserHost;
let context: ToolContext;
beforeEach(async () => {
  mock.root = await mkdtemp(join(tmpdir(), "harness-browser-host-")); mock.views.length = 0; mock.partitions.clear();
  host = new DesktopBrowserHost(async (sessionId, runId) => {
    if (runId && runId !== `run-${sessionId}`) throw new Error("Run does not belong to session");
    return { workspacePath: mock.root };
  });
  host.attach(Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send: vi.fn(), getZoomFactor: () => 1 }, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }) as unknown as BrowserWindow);
  context = { sessionId: "a", runId: "run-a", workspacePath: mock.root, grants: [], signal: new AbortController().signal };
  await host.listen();
});
afterEach(async () => { host.close(); await rm(mock.root, { recursive: true, force: true }); });
const request = (input: Parameters<typeof desktopBrowserRequest>[2], ctx = context) => desktopBrowserRequest(host.endpoint, host.token, input, ctx);

it("opens local files manually and navigates to them through the agent bridge", async () => {
  const opened = (await host.manual("a", { action: "new_tab", url: "file:///D:/项目/preview page.html" })).output as { tabId: string };
  const view = mock.views[0] as View;
  expect(view.webContents.getURL()).toBe("file:///D:/%E9%A1%B9%E7%9B%AE/preview%20page.html");
  const result = await request({ action: "navigate", tabId: opened.tabId, url: "file:///D:/preview/next.html#details" });
  expect(result.output).toMatchObject({ tabId: opened.tabId, url: "file:///D:/preview/next.html#details" });
  expect(view.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  for (const eventName of ["will-navigate", "will-redirect"]) {
    const event = { preventDefault: vi.fn() };
    view.webContents.emit(eventName, event, "file:///D:/preview/linked.html");
    expect(event.preventDefault).not.toHaveBeenCalled();
    view.webContents.emit(eventName, event, "javascript:alert(1)");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  const popup = view.webContents.setWindowOpenHandler.mock.calls[0]![0]({ url: "file:///D:/preview/popup.html" });
  expect(popup.action).toBe("allow");
  expect(popup.createWindow({}).getURL()).toBe("file:///D:/preview/popup.html");
});

it("authenticates the real pipe and validates the run's owning conversation", async () => {
  await expect(desktopBrowserRequest(host.endpoint, "invalid", { action: "tabs" }, context)).rejects.toThrow("无效");
  await expect(request({ action: "tabs" }, { ...context, runId: "run-b" })).rejects.toThrow("does not belong");
  expect((await request({ action: "tabs" })).output).toMatchObject({ sessionId: "a", tabs: [] });
});

it("pins agent operations to their tab when the user selects another tab and isolates sessions", async () => {
  const first = (await request({ action: "new_tab", url: "https://example.com/first" })).output as { tabId: string };
  const second = (await host.manual("a", { action: "new_tab", url: "https://example.com/second" })).output as { tabId: string };
  expect((await request({ action: "snapshot" })).output).toMatchObject({ tabId: first.tabId });
  await host.manual("b", { action: "new_tab", url: "https://example.com/other" });
  await expect(request({ action: "snapshot", tabId: second.tabId }, { ...context, sessionId: "b", runId: "run-b" })).rejects.toThrow("标签页不存在");
  const views = mock.views as View[];
  expect(views[0]!.options.webPreferences!.partition).not.toBe(views[2]!.options.webPreferences!.partition);
  host.setLayout({ sessionId: "a", visible: true, obscured: false, x: 700, y: 150, width: 400, height: 600 });
  expect(views.map(view => view.visible)).toEqual([true, false, false]);
  host.setLayout({ sessionId: "a", visible: true, obscured: true, x: 700, y: 150, width: 400, height: 600 });
  expect(views.every(view => !view.visible)).toBe(true);
});

it("aborts a loading page when the caller cancels the pipe request", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  const view = mock.views[0] as View; view.webContents.loading = true;
  const controller = new AbortController();
  const pending = request({ action: "snapshot" }, { ...context, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("取消");
  await vi.waitFor(() => expect(view.webContents.listenerCount("did-stop-loading")).toBe(2));
  controller.abort(); await rejected;
  await vi.waitFor(() => expect(view.webContents.stop).toHaveBeenCalled());
});

it("opens a popup as a real tab inside the conversation's own partition", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  const opener = mock.views[0] as View;
  const handler = opener.webContents.setWindowOpenHandler.mock.calls[0]![0];
  const response = handler({ url: "https://example.com/popup" });
  expect(response.action).toBe("allow");
  // Electron passes createWindow a BrowserWindowConstructorOptions, never a webContents. The host
  // must therefore build the popup's contents itself, share the opener's partition, and load the
  // popup URL on it — otherwise the popup silently becomes a blank page.
  const created = response.createWindow({ show: true }) as unknown as View["webContents"];
  expect(mock.views).toHaveLength(2);
  expect(created).toBe((mock.views[1] as View).webContents);
  expect((mock.views[1] as View).options.webPreferences?.partition).toBe(opener.options.webPreferences?.partition);
  expect(created.getURL()).toBe("https://example.com/popup");
});

it("adopts Electron's supplied popup WebContents when present", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  const opener = mock.views[0] as View;
  const handler = opener.webContents.setWindowOpenHandler.mock.calls[0]![0];
  const response = handler({ url: "https://example.com/popup" });
  const supplied = new EventEmitter() as View["webContents"];
  Object.assign(supplied, { loading: false, stop: vi.fn(), close: vi.fn(), setWindowOpenHandler: vi.fn(), debugger: { sendCommand: vi.fn(), isAttached: () => true }, getURL: () => "https://example.com/popup", isDestroyed: () => false, getTitle: () => "popup", navigationHistory: { canGoBack: () => false, canGoForward: () => false } });
  const created = response.createWindow({ show: true, webContents: supplied } as never) as View["webContents"];
  expect(created).toBe(supplied);
  expect(mock.views).toHaveLength(2);
});

it("rejects an upload after the destination URL changes", async () => {
  await request({ action: "new_tab", url: "https://example.com/changed" });
  await writeFile(join(mock.root, "fixture.txt"), "fixture");
  await expect(request({ action: "upload", url: "https://example.com/original", selector: "input", paths: ["fixture.txt"] })).rejects.toThrow("网页地址已改变");
  expect((mock.views[0] as View).webContents.debugger.sendCommand).not.toHaveBeenCalled();
});

it("cancels a pending download and removes only its reserved file", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  const transfer = (await request({ action: "download", url: "https://example.com/fixture.txt" })).output as { downloadId: string; path: string };
  expect((await stat(join(mock.root, transfer.path))).isFile()).toBe(true);
  await request({ action: "cancel_download", downloadId: transfer.downloadId });
  await expect(stat(join(mock.root, transfer.path))).rejects.toThrow();
  expect((await request({ action: "downloads" })).output).toMatchObject({ downloads: [{ id: transfer.downloadId, status: "cancelled" }] });
});

it("removes pending download reservations when the desktop closes", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  const transfer = (await request({ action: "download", url: "https://example.com/fixture.txt" })).output as { path: string };
  host.close();
  await vi.waitFor(async () => { await expect(stat(join(mock.root, transfer.path))).rejects.toThrow(); });
});

it("closes once across the two before-quit passes after Electron releases view contents", async () => {
  await request({ action: "new_tab", url: "https://example.com/first" });
  await host.manual("b", { action: "new_tab", url: "https://example.com/second" });
  const contents = mock.views.map(view => (view as View).webContents);
  const closers = contents.map((item, index) => vi.spyOn(item as unknown as { close(): void }, "close").mockImplementation(() => {
    // Closing an Electron view can clear its webContents getter before app.quit()
    // emits the second before-quit. Reproduce that native lifetime explicitly.
    Object.defineProperty(mock.views[index], "webContents", { configurable: true, value: undefined });
  }));
  expect(() => host.close()).not.toThrow();
  expect(() => host.close()).not.toThrow();
  for (const close of closers) expect(close).toHaveBeenCalledOnce();
});

it("can shut down when an Electron view has already released its contents", async () => {
  await request({ action: "new_tab", url: "https://example.com" });
  Object.defineProperty(mock.views[0], "webContents", { configurable: true, value: undefined });
  expect(() => host.close()).not.toThrow();
  expect(() => host.close()).not.toThrow();
});

