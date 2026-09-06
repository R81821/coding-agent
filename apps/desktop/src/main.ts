import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  screen,
  Tray,
} from "electron";
import type { DaemonRequest, DaemonResponse } from "@harness/protocol";
import { daemonEndpointName, DaemonResponseSchema, newId } from "@harness/protocol";
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
import { appendBounded, daemonStartupError } from "./daemon-startup.js";
import { sanitizeRendererRequest } from "./renderer-ipc.js";

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
let currentPassphrase: string | undefined;
let daemonStarting: Promise<void> | undefined;
const backgroundLaunch = process.argv.includes("--background");
let showWindowWhenReady = !backgroundLaunch;
const credentialStore = new WindowsCredentialStore();

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
app.on("before-quit", () => {
  quitting = true;
  if (daemon) killDaemonTree(daemon);
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
      daemon?.kill();
      daemon = undefined;
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
    return daemonRequest({
      id: newId("request"),
      method: sanitized.method,
      params: sanitized.params,
    } as DaemonRequest);
  },
);

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
      result.filePaths.map(async (path) =>
        normalizeAndPut(await readFile(path), "file", allowedProviders),
      ),
    );
  },
);

ipcMain.handle(
  "harness:put-image",
  async (
    _event,
    input: {
      base64: string;
      mimeType: string;
      source: "clipboard" | "screenshot";
      allowedProviders: string[];
    },
  ) => {
    return normalizeAndPut(
      Buffer.from(input.base64, "base64"),
      input.source,
      input.allowedProviders,
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
  createWindow(showWindowWhenReady);
  createTray();
  app.setLoginItemSettings({ openAtLogin: true, args: ["--background"] });
}

function createWindow(show: boolean): void {
  void logLifecycle("create-window", { show });
  window = new BrowserWindow({
    show,
    width: 1480,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: "#211e27",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: existsSync(join(here, "preload.cjs"))
        ? join(here, "preload.cjs")
        : join(here, "..", "dist-electron", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
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
  const packagedPath = join(process.resourcesPath, "daemon", "main.js");
  const daemonEnvironment = {
    ...process.env,
    ...credentialEnvironment,
    ...settingsEnvironment,
    HARNESS_APP_DATA_PATH: app.getPath("userData"),
    HARNESS_DAEMON_INSTANCE: daemonInstanceId,
  };
  if (app.isPackaged)
    daemon = spawn(process.execPath, [packagedPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...daemonEnvironment, ELECTRON_RUN_AS_NODE: "1" },
    });
  else
    daemon = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--filter", "@harness/daemon", "dev"],
      {
        cwd: join(here, "..", "..", ".."),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
        env: daemonEnvironment,
      },
    );
  daemon.stdin?.write(`${passphrase}\n`);
  daemon.stdin?.end();
  let stderr = "";
  let spawnError: Error | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  daemon.stdout?.on("data", (chunk: Buffer | string) => process.stdout.write(chunk));
  daemon.stderr?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr = appendBounded(stderr, text);
    process.stderr.write(text);
  });
  daemon.once("error", (error) => { spawnError = error; });
  daemon.once("exit", (code, signal) => {
    exited = { code, signal };
    void logLifecycle("daemon-exit", { code, signal, stderr });
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (spawnError) throw spawnError;
    if (exited) throw daemonStartupError(stderr, exited.code);
    try {
      await daemonRequest({ id: newId("request"), method: "health" }, 500);
      void logLifecycle("daemon-ready");
      return;
    } catch {
      /* wait */
    }
  }
  void logLifecycle("daemon-timeout", { stderr });
  throw stderr ? daemonStartupError(stderr, daemon?.exitCode ?? null) : new Error("daemon 在 30 秒内未建立通信管道。详情已写入桌面生命周期日志。");
}

async function restartDaemon(): Promise<void> {
  if (!currentPassphrase) return;
  if (daemon) {
    const previous = daemon;
    const pid = previous.pid;
    const stopped = new Promise<void>((resolveStop) =>
      previous.once("exit", () => resolveStop()),
    );
    killDaemonTree(previous);
    const exited = await Promise.race([
      stopped.then(() => true),
      new Promise<boolean>((resolveWait) =>
        setTimeout(
          () => resolveWait(pid !== undefined && !isProcessAlive(pid)),
          2_000,
        ),
      ),
    ]);
    if (!exited) throw new Error("旧 daemon 进程未能在 2 秒内退出，请稍后重试");
    daemon = undefined;
  }
  await ensureDaemon(currentPassphrase);
}

function killDaemonTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else child.kill();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
) {
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(bytes, { animated: true }).metadata();
  if (
    !metadata.format ||
    !["png", "jpeg", "gif", "webp"].includes(metadata.format)
  )
    throw new Error("仅支持 PNG、JPEG、GIF 和 WebP");
  if ((metadata.width ?? 0) * (metadata.height ?? 0) > 40_000_000)
    throw new Error("图片像素总量不能超过 4000 万");
  const format = metadata.format === "jpg" ? "jpeg" : metadata.format;
  const normalized = await sharp(bytes, { animated: true })
    .rotate()
    .toFormat(format as "png" | "jpeg" | "gif" | "webp")
    .toBuffer();
  if (normalized.byteLength > 30_000_000) throw new Error("图片不能超过 30 MB");
  const mimeType = `image/${format}`;
  const attachment = await daemonRequest(
    {
      id: newId("request"),
      method: "attachment.put",
      params: {
        base64: normalized.toString("base64"),
        mimeType,
        source,
        allowedProviders,
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
  };
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
