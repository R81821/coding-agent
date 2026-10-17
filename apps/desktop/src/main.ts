import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  screen,
  Tray,
} from "electron";
import type { AttachmentRef, DaemonRequest, DaemonResponse } from "@harness/protocol";
import { attachmentFileName, attachmentMimeTypeForFileName, daemonEndpointName, DaemonResponseSchema, MAX_ATTACHMENT_BYTES, newId } from "@harness/protocol";
import type { DesktopAttachment } from "./preload.js";
import { ensureV2Storage } from "@harness/persistence";
import {
  credentialNames,
  WindowsCredentialStore,
  type CredentialName,
} from "./credential-store.js";
import {
  loadProviderSettings,
  providerSettingsEnvironment,
  saveProviderSettings,
} from "./provider-settings.js";
import { appendBounded, daemonStartupError, DaemonStartupMonitor } from "./daemon-startup.js";
import { stopDaemonProcess } from "./daemon-process.js";
import { developmentDaemonCommand } from "./daemon-launch.js";
import { QuitCoordinator } from "./quit-coordinator.js";
import { sanitizeRendererRequest } from "./renderer-ipc.js";
import { messageHttpUrl } from "./message-links.js";
import { runDesktopCommand } from "./desktop-menu.js";
import { DesktopBrowserHost } from "./browser-host.js";
import { BrowserLayoutSchema, type RunSpec, type SessionDetail } from "@harness/protocol";
import { guardProcessOutput } from "./output-pipe-guard.js";

// Install before startup logs and before asynchronous Node/Electron warnings are emitted.
guardProcessOutput();

ipcMain.handle("harness:open-external", async (_event, value: unknown) => {
  const url = messageHttpUrl(value);
  if (!url) throw new Error("仅支持有效的 HTTP(S) 链接");
  await shell.openExternal(url);
});

const here = dirname(fileURLToPath(import.meta.url));
const daemonInstanceId = newId("desktop");
const endpointName = daemonEndpointName(daemonInstanceId);
const pipePath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\${endpointName}`
    : join(tmpdir(), `${endpointName}.sock`);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let daemon: ChildProcess | undefined;
let quitting = false;
const quitCoordinator = new QuitCoordinator();
let quitRequested = false;
let currentPassphrase: string | undefined;
let browserHost: DesktopBrowserHost | undefined;
let daemonStarting: Promise<void> | undefined;
const backgroundLaunch = process.argv.includes("--background");
let showWindowWhenReady = !backgroundLaunch;
const credentialStore = new WindowsCredentialStore();

ipcMain.handle("harness:desktop-command", async (event, command: unknown) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("无效的窗口来源");
  if (command === "quit") { app.quit(); return; }
  if (command === "about") {
    await dialog.showMessageBox(window, { type: "info", title: "关于 Harness", message: "Harness Agent", detail: `版本 ${app.getVersion()}\n本地开发助手`, buttons: ["知道了"] });
    return;
  }
  runDesktopCommand(window, command);
});
ipcMain.handle("harness:titlebar-theme", (event, theme: unknown) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("无效的窗口来源");
  if (theme !== "classic" && theme !== "kelo") throw new Error("无效的主题");
  if (process.platform !== "darwin") window.setTitleBarOverlay({ color: theme === "kelo" ? "#ffffff" : "#211e27", symbolColor: theme === "kelo" ? "#303540" : "#f5f3f7", height: 42 });
});

process.stderr.write(
  `[Harness Agent] main-entry background=${String(backgroundLaunch)}\n`,
);
const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  process.stderr.write("[Harness Agent] secondary-instance-exit\n");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    void logLifecycle("second-instance");
    showMainWindow();
  });
  app.on("activate", () => {
    void logLifecycle("activate");
    showMainWindow();
  });
  void app
    .whenReady()
    .then(initializeDesktop)
    .catch((error: unknown) => {
      process.stderr.write(
        `[Harness Agent] startup-failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      app.exit(1);
    });
}

app.on("window-all-closed", () => {
  /* tray keeps the daemon alive */
});
app.on("before-quit", (event) => {
  if (quitCoordinator.completed) return;
  event.preventDefault();
  if (quitRequested) return;
  quitRequested = true;
  quitting = true;
  void quitCoordinator.run(async () => {
    // Let an in-flight start settle before deciding which process must be stopped.
    await daemonStarting?.catch(() => {});
    browserHost?.close();
    if (daemon) {
      const previous = daemon;
      await stopDaemonProcess(previous);
      if (daemon === previous) daemon = undefined;
    }
  }).then(() => app.quit()).catch((error: unknown) => {
    quitRequested = false;
    quitting = false;
    void logLifecycle("daemon-stop-failed", { error: String(error) });
    dialog.showErrorBox("退出未完成", error instanceof Error ? error.message : String(error));
  });
});

ipcMain.handle(
  "harness:unlock",
  async (
    _event,
    input: { passphrase?: unknown; remember?: unknown; restore?: unknown },
  ) => {
    const restored = input?.restore
      ? await readRememberedPassphrase()
      : undefined;
    const passphrase =
      typeof input?.passphrase === "string" && input.passphrase
        ? input.passphrase
        : restored;
    if (typeof passphrase !== "string" || passphrase.length < 10)
      return {
        ok: false,
        error: input?.restore ? undefined : "应用口令至少需要 10 个字符",
      };
    try {
      await ensureDaemon(passphrase);
      await daemonRequest({ id: newId("request"), method: "health" });
      currentPassphrase = passphrase;
      if (!input?.restore) {
        if (input?.remember) await rememberPassphrase(passphrase);
        else await forgetRememberedPassphrase();
      }
      return { ok: true };
    } catch (error) {
      if (daemon) {
        const previous = daemon;
        try {
          await stopDaemonProcess(previous);
          if (daemon === previous) daemon = undefined;
        } catch (stopError) {
          void logLifecycle("daemon-stop-failed", { error: String(stopError) });
        }
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle("harness:credentials-status", async () =>
  credentialStore.status(),
);
ipcMain.handle(
  "harness:credentials-set",
  async (_event, input: { name: unknown; value: unknown }) => {
    if (
      !credentialNames.includes(input?.name as CredentialName) ||
      typeof input?.value !== "string"
    )
      throw new Error("无效的凭据字段");
    await credentialStore.set(input.name as CredentialName, input.value);
    await restartDaemon();
    return credentialStore.status();
  },
);
ipcMain.handle("harness:credentials-delete", async (_event, name: unknown) => {
  if (!credentialNames.includes(name as CredentialName))
    throw new Error("无效的凭据字段");
  await credentialStore.delete(name as CredentialName);
  await restartDaemon();
  return credentialStore.status();
});

ipcMain.handle("harness:provider-settings", async () =>
  loadProviderSettings(providerSettingsPath()),
);

ipcMain.handle("harness:memory-export", async (_event, memoryIds: string[]) => {
  const data = await daemonRequest({ id: newId("request"), method: "memory.export", params: { memoryIds } });
  const result = await dialog.showSaveDialog({
    title: "导出选中的记忆（明文 JSON，请妥善保管）",
    defaultPath: `harness-memories-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await writeFile(result.filePath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  return { canceled: false, path: result.filePath };
});
ipcMain.handle(
  "harness:provider-settings-set",
  async (_event, input: unknown) => {
    const settings = await saveProviderSettings(providerSettingsPath(), input);
    await restartDaemon();
    return settings;
  },
);

ipcMain.handle(
  "harness:request",
  async (_event, request: { method?: unknown; params?: unknown }) => {
    if (!request || typeof request.method !== "string")
      throw new Error("无效的 daemon 请求");
    const sanitized = sanitizeRendererRequest(request.method, request.params);
    const result = await daemonRequest({
      id: newId("request"),
      method: sanitized.method,
      params: sanitized.params,
    } as DaemonRequest);
    if (sanitized.method === "session.purge" && sanitized.params && typeof sanitized.params === "object" && "sessionId" in sanitized.params) await browserHost?.purge(String(sanitized.params.sessionId));
    return result;
  },
);

function assertDesktopBrowserSender(event: Electron.IpcMainInvokeEvent): DesktopBrowserHost {
  if (!window || !browserHost || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("无效的浏览器界面来源");
  return browserHost;
}
ipcMain.handle("harness:browser-state", (event, id: unknown) => {
  if (typeof id !== "string" || !id || id.length > 120) throw new Error("无效的对话");
  return assertDesktopBrowserSender(event).state(id);
});
ipcMain.handle("harness:browser-command", (event, id: unknown, input: unknown) => {
  if (typeof id !== "string" || !id || id.length > 120) throw new Error("无效的对话");
  return assertDesktopBrowserSender(event).manual(id, input);
});
ipcMain.handle("harness:browser-layout", (event, input: unknown) => assertDesktopBrowserSender(event).setLayout(BrowserLayoutSchema.parse(input)));

ipcMain.handle("harness:choose-workspace", async () => {
  const result = await dialog.showOpenDialog(window!, {
    title: "选择代码工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle(
  "harness:choose-images",
  async (_event, allowedProviders: string[]) => {
    const result = await dialog.showOpenDialog(window!, {
      title: "选择图片",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (path) => normalizeAndPut(await readAttachmentFile(path), "file", attachmentProviders(allowedProviders), basename(path))),
    );
  },
);

ipcMain.handle("harness:choose-files", async (_event, allowedProviders: string[]) => {
  const providers = attachmentProviders(allowedProviders);
  const result = await dialog.showOpenDialog(window!, {
    title: "选择文件",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "文本、代码和文档", extensions: ["txt", "md", "mdx", "csv", "json", "yaml", "yml", "xml", "html", "css", "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "cs", "sh", "ps1", "sql", "toml", "ini", "log", "pdf", "docx"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map(async path => putFileBytes(await readAttachmentFile(path), basename(path), "file", providers)));
});

ipcMain.handle("harness:put-file", async (_event, input: {
  base64: string; mimeType: string; fileName: string; source: "file" | "clipboard"; allowedProviders: string[];
}) => {
  if (!input || !["file", "clipboard"].includes(input.source)) throw new Error("无效的附件来源");
  return putFileBytes(decodeAttachmentBytes(input.base64), input.fileName, input.source, attachmentProviders(input.allowedProviders));
});

ipcMain.handle(
  "harness:put-image",
  async (
    _event,
    input: {
      base64: string;
      mimeType: string;
      source: "file" | "clipboard" | "screenshot";
      allowedProviders: string[];
      fileName?: string;
    },
  ) => {
    if (!input || !["file", "clipboard", "screenshot"].includes(input.source)) throw new Error("无效的图片来源");
    return normalizeAndPut(
      decodeAttachmentBytes(input.base64),
      input.source,
      attachmentProviders(input.allowedProviders),
      input.fileName,
    );
  },
);

ipcMain.handle("harness:capture-screen", async () => {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: display.size,
  });
  const source = sources[0];
  if (!source) throw new Error("无法读取屏幕画面");
  const image = source.thumbnail;
  return {
    dataUrl: image.toDataURL(),
    width: image.getSize().width,
    height: image.getSize().height,
  };
});

async function initializeDesktop(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const legacyRuntimePath = join(process.env.LOCALAPPDATA ?? userDataPath, "HarnessAgent");
  await ensureV2Storage(userDataPath, legacyRuntimePath === userDataPath ? [] : [legacyRuntimePath]);
  await logLifecycle("ready", { showWindowWhenReady });
  browserHost = new DesktopBrowserHost(async (sessionId, runId) => {
    const detail = await daemonRequest<SessionDetail>({ id: newId("request"), method: "session.view", params: { sessionId, limit: 1 } });
    if (!detail?.session || detail.session.deletedAt) throw new Error("浏览器对话不存在或已被删除");
    if (runId) {
      const run = await daemonRequest<{ spec: RunSpec; status: string }>({ id: newId("request"), method: "run.get", params: { runId } });
      if (!run || run.spec.sessionId !== sessionId || !["running", "verifying", "planning"].includes(run.status)) throw new Error("浏览器调用与当前运行不匹配");
    }
    return { workspacePath: detail.session.workspacePath };
  });
  await browserHost.listen();
  createWindow(showWindowWhenReady);
  createTray();
  app.setLoginItemSettings({ openAtLogin: true, args: ["--background"] });
}

function createWindow(show: boolean): void {
  void logLifecycle("create-window", { show });
  window = new BrowserWindow({
    show,
    width: 1324,
    height: 839,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#211e27",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" ? { titleBarOverlay: { color: "#211e27", symbolColor: "#f5f3f7", height: 42 } } : {}),
    webPreferences: {
      preload: existsSync(join(here, "preload.cjs"))
        ? join(here, "preload.cjs")
        : join(here, "..", "dist-electron", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const createdWindow = window;
  // Bring an explicit launch forward after the renderer's first paint. Background
  // login launches stay hidden, and closing during startup cancels the reveal.
  createdWindow.once("ready-to-show", () => {
    if (!quitting && showWindowWhenReady && window === createdWindow && !createdWindow.isDestroyed()) showMainWindow();
  });
  Menu.setApplicationMenu(null);
  browserHost?.attach(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(here, "..", "dist", "index.html"));
  window.on("show", () => {
    void logLifecycle("window-shown");
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      void logLifecycle("renderer-load-failed", {
        errorCode,
        errorDescription,
      });
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    void logLifecycle("renderer-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.on("close", (event) => {
    void logLifecycle("window-close", { quitting });
    if (!quitting) {
      event.preventDefault();
      showWindowWhenReady = false;
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });
}

function showMainWindow(): void {
  showWindowWhenReady = true;
  void logLifecycle("show-window-request", {
    ready: app.isReady(),
    hasWindow: Boolean(window && !window.isDestroyed()),
  });
  if (!app.isReady()) return;
  if (!window || window.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.setSkipTaskbar(false);
  window.show();
  window.moveTop();
  window.focus();
}

async function logLifecycle(
  event: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    const logsDirectory = app.getPath("logs");
    await mkdir(logsDirectory, { recursive: true });
    await appendFile(
      join(logsDirectory, "desktop-lifecycle.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
      "utf8",
    );
  } catch {
    /* diagnostics must never block startup */
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAK0lEQVR42mNgwAf+M4TBgEFGmkGKAQMDQyMDA8N/BoYGBiYGRgYGJgZGBgB9VAQfkgjhgwAAAABJRU5ErkJggg==",
  );
  tray = new Tray(icon);
  tray.setToolTip("Harness Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Harness Agent", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

async function ensureDaemon(passphrase: string): Promise<void> {
  if (daemonStarting) return daemonStarting;
  daemonStarting = startDaemon(passphrase).finally(() => {
    daemonStarting = undefined;
  });
  return daemonStarting;
}

async function startDaemon(passphrase: string): Promise<void> {
  if (quitting) throw new Error("应用正在退出，已取消启动 daemon");
  try {
    await daemonRequest({ id: newId("request"), method: "health" }, 1_000);
    return;
  } catch {
    /* start below */
  }
  const credentialEnvironment = await credentialStore.environment();
  const settingsEnvironment = providerSettingsEnvironment(
    await loadProviderSettings(providerSettingsPath()),
  );
  if (quitting) throw new Error("应用正在退出，已取消启动 daemon");
  const packagedPath = join(process.resourcesPath, "daemon", "main.js");
  const daemonEnvironment = {
    ...process.env,
    ...credentialEnvironment,
    ...settingsEnvironment,
    HARNESS_APP_DATA_PATH: app.getPath("userData"),
    HARNESS_DAEMON_INSTANCE: daemonInstanceId,
    HARNESS_DESKTOP_PID: String(process.pid),
    ...(browserHost ? { HARNESS_BROWSER_BRIDGE: browserHost.endpoint, HARNESS_BROWSER_TOKEN: browserHost.token } : {}),
  };
  if (app.isPackaged)
    daemon = spawn(process.execPath, [packagedPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...daemonEnvironment, ELECTRON_RUN_AS_NODE: "1" },
    });
  else {
    const command = developmentDaemonCommand(join(here, "..", "..", ".."));
    daemon = spawn(process.execPath, command.args, {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...daemonEnvironment, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  const startup = new DaemonStartupMonitor();
  let stderr = "";
  let spawnError: Error | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  daemon.stdout?.on("data", (chunk: Buffer | string) => process.stdout.write(chunk));
  daemon.stderr?.setEncoding("utf8");
  daemon.stderr?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr = appendBounded(stderr, text);
    for (const progress of startup.consume(text)) void logLifecycle("daemon-startup-progress", { ...progress, ...startup.diagnostics() });
    process.stderr.write(text);
  });
  daemon.once("error", (error) => { spawnError = error; });
  daemon.once("exit", (code, signal) => {
    exited = { code, signal };
    void logLifecycle("daemon-exit", { code, signal, stderr });
  });
  daemon.stdin?.write(`${passphrase}\n`);
  daemon.stdin?.end();
  while (!startup.expired) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (quitting) throw new Error("应用正在退出，已取消等待 daemon 启动");
    if (spawnError) throw spawnError;
    if (startup.failure) throw startup.failure;
    if (exited) throw daemonStartupError(stderr, exited.code);
    if (startup.expired) break;
    try {
      await daemonRequest({ id: newId("request"), method: "health" }, 500);
      void logLifecycle("daemon-ready");
      return;
    } catch {
      /* wait */
    }
  }
  void logLifecycle("daemon-timeout", { stderr, ...startup.diagnostics() });
  throw startup.timeoutError();
}

async function restartDaemon(): Promise<void> {
  if (!currentPassphrase) return;
  if (daemon) {
    const previous = daemon;
    await stopDaemonProcess(previous);
    daemon = undefined;
  }
  await ensureDaemon(currentPassphrase);
}

async function rememberPassphrase(passphrase: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("此设备无法使用 Windows DPAPI");
  const path = join(app.getPath("userData"), "device-unlock.bin");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, safeStorage.encryptString(passphrase), { mode: 0o600 });
}

async function readRememberedPassphrase(): Promise<string | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(
      await readFile(join(app.getPath("userData"), "device-unlock.bin")),
    );
  } catch {
    return undefined;
  }
}

async function forgetRememberedPassphrase(): Promise<void> {
  await rm(join(app.getPath("userData"), "device-unlock.bin"), { force: true });
}

function providerSettingsPath(): string {
  return join(app.getPath("userData"), "provider-settings.json");
}

async function normalizeAndPut(
  bytes: Buffer,
  source: "file" | "clipboard" | "screenshot",
  allowedProviders: string[],
  originalFileName?: string,
): Promise<DesktopAttachment> {
  assertAttachmentSize(bytes.byteLength);
  const fileName = typeof originalFileName === "string" ? attachmentFileName(originalFileName) : undefined;
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(bytes, { animated: true }).metadata();
  if (
    !metadata.format ||
    !["png", "jpeg", "gif", "webp"].includes(metadata.format)
  )
    throw new Error("仅支持 PNG、JPEG、GIF 和 WebP");
  if ((metadata.width ?? 0) * (metadata.height ?? 0) > 40_000_000)
    throw new Error("图片像素总量不能超过 4000 万");
  const format = metadata.format;
  const normalized = await sharp(bytes, { animated: true })
    .rotate()
    .toFormat(format as "png" | "jpeg" | "gif" | "webp")
    .toBuffer();
  assertAttachmentSize(normalized.byteLength);
  const mimeType = `image/${format}`;
  const attachment = await daemonRequest<AttachmentRef>(
    {
      id: newId("request"),
      method: "attachment.put",
      params: {
        base64: normalized.toString("base64"),
        mimeType,
        source,
        allowedProviders,
        ...(fileName ? { fileName } : {}),
      },
    },
    60_000,
  );
  const preview = await sharp(normalized, { animated: false })
    .resize({
      width: 640,
      height: 400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return {
    attachment,
    previewDataUrl: `data:image/png;base64,${preview.toString("base64")}`,
    ...(fileName ? { fileName } : {}),
  };
}

function attachmentProviders(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) throw new Error("无效的附件模型范围");
  return value;
}

function assertAttachmentSize(size: number): void {
  if (size === 0 || size > MAX_ATTACHMENT_BYTES) throw new Error("附件大小必须在 1 字节到 30 MB 之间");
}

async function readAttachmentFile(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("请选择有效的文件附件");
  assertAttachmentSize(metadata.size);
  const bytes = await readFile(path);
  assertAttachmentSize(bytes.byteLength);
  return bytes;
}

function decodeAttachmentBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || value.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("附件内容无效或超过 30 MB，请重新选择文件");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("附件内容编码无效，请重新选择文件");
  assertAttachmentSize(bytes.byteLength);
  return bytes;
}

async function putFileBytes(bytes: Buffer, originalFileName: string, source: "file" | "clipboard", allowedProviders: string[]): Promise<DesktopAttachment> {
  const fileName = typeof originalFileName === "string" ? attachmentFileName(originalFileName) : undefined;
  const mimeType = fileName ? attachmentMimeTypeForFileName(fileName) : undefined;
  if (!fileName || !mimeType) throw new Error("不支持此文件格式。请选择文本、源代码、PDF、DOCX 或 PNG、JPEG、GIF、WebP 图片");
  assertAttachmentSize(bytes.byteLength);
  if (mimeType.startsWith("image/")) return normalizeAndPut(bytes, source, allowedProviders, fileName);
  const attachment = await daemonRequest<AttachmentRef>({ id: newId("request"), method: "attachment.put", params: {
    base64: bytes.toString("base64"), mimeType, fileName, source, allowedProviders,
  } }, 60_000);
  return { attachment, previewDataUrl: "", fileName };
}

async function daemonRequest<T = unknown>(
  request: DaemonRequest,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise<T>((resolveRequest, reject) => {
    const socket = connect(pipePath);
    socket.setEncoding("utf8");
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("daemon 请求超时"));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = DaemonResponseSchema.parse(
          JSON.parse(buffer.slice(0, newline)),
        ) as DaemonResponse;
        if (!response.ok)
          reject(new Error(response.error?.message ?? "daemon 请求失败"));
        else resolveRequest(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
