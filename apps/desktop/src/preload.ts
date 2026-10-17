import { contextBridge, ipcRenderer } from "electron";
import type { DaemonRequestInput } from "@harness/protocol";
import type { ProviderSettings } from "./provider-settings.js";
import type { DesktopCommand } from "./desktop-menu.js";
import type { BrowserAction, BrowserState, BrowserLayout } from "@harness/protocol";

const api = {
  browserState: (sessionId: string) => ipcRenderer.invoke("harness:browser-state", sessionId) as Promise<BrowserState>,
  browserCommand: (sessionId: string, input: BrowserAction) => ipcRenderer.invoke("harness:browser-command", sessionId, input) as Promise<unknown>,
  browserLayout: (layout: BrowserLayout) => ipcRenderer.invoke("harness:browser-layout", layout) as Promise<void>,
  onBrowserState: (callback: (state: BrowserState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) => callback(state);
    ipcRenderer.on("harness:browser-state", listener);
    return () => { ipcRenderer.removeListener("harness:browser-state", listener); };
  },
  desktopPlatform: process.platform,
  desktopCommand: (command: DesktopCommand) => ipcRenderer.invoke("harness:desktop-command", command) as Promise<void>,
  setTitlebarTheme: (theme: "classic" | "kelo") => ipcRenderer.invoke("harness:titlebar-theme", theme) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke("harness:open-external", url) as Promise<void>,
  exportMemories: (memoryIds: string[]) => ipcRenderer.invoke("harness:memory-export", memoryIds) as Promise<{ canceled: boolean; path?: string }>,
  unlock: (passphrase: string, remember = false) =>
    ipcRenderer.invoke("harness:unlock", { passphrase, remember }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  restoreUnlock: () =>
    ipcRenderer.invoke("harness:unlock", { restore: true }) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  credentialStatus: () =>
    ipcRenderer.invoke("harness:credentials-status") as Promise<
      Record<string, boolean>
    >,
  setCredential: (name: string, value: string) =>
    ipcRenderer.invoke("harness:credentials-set", { name, value }) as Promise<
      Record<string, boolean>
    >,
  deleteCredential: (name: string) =>
    ipcRenderer.invoke("harness:credentials-delete", name) as Promise<
      Record<string, boolean>
    >,
  providerSettings: () =>
    ipcRenderer.invoke(
      "harness:provider-settings",
    ) as Promise<ProviderSettings>,
  setProviderSettings: (settings: ProviderSettings) =>
    ipcRenderer.invoke(
      "harness:provider-settings-set",
      settings,
    ) as Promise<ProviderSettings>,
  request: <T>(request: DaemonRequestInput) =>
    ipcRenderer.invoke("harness:request", request) as Promise<T>,
  chooseWorkspace: () =>
    ipcRenderer.invoke("harness:choose-workspace") as Promise<
      string | undefined
    >,
  chooseImages: (allowedProviders: string[]) =>
    ipcRenderer.invoke("harness:choose-images", allowedProviders) as Promise<
      DesktopAttachment[]
    >,
  chooseFiles: (allowedProviders: string[]) =>
    ipcRenderer.invoke("harness:choose-files", allowedProviders) as Promise<DesktopAttachment[]>,
  putFile: (
    base64: string,
    mimeType: string,
    fileName: string,
    source: "file" | "clipboard",
    allowedProviders: string[],
  ) => ipcRenderer.invoke("harness:put-file", { base64, mimeType, fileName, source, allowedProviders }) as Promise<DesktopAttachment>,
  putImage: (
    base64: string,
    mimeType: string,
    source: "file" | "clipboard" | "screenshot",
    allowedProviders: string[],
    fileName?: string,
  ) =>
    ipcRenderer.invoke("harness:put-image", {
      base64,
      mimeType,
      source,
      allowedProviders,
      ...(fileName ? { fileName } : {}),
    }) as Promise<DesktopAttachment>,
  captureScreen: () =>
    ipcRenderer.invoke("harness:capture-screen") as Promise<{
      dataUrl: string;
      width: number;
      height: number;
    }>,
};

export interface DesktopAttachment {
  attachment: import("@harness/protocol").AttachmentRef;
  previewDataUrl: string;
  /** Display name mirrored from the persisted reference; also supports older local drafts. */
  fileName?: string;
}

contextBridge.exposeInMainWorld("harness", api);

declare global {
  interface Window {
    harness: typeof api;
  }
}
