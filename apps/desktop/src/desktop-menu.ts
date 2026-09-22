export type DesktopCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" | "reload" | "devtools" | "zoom-in" | "zoom-out" | "zoom-reset" | "fullscreen" | "minimize" | "maximize" | "close" | "quit" | "about";
export type WorkspaceMenuCommand = "new-task" | "open-project" | "settings";
export type MenuCommand = DesktopCommand | WorkspaceMenuCommand;

export function desktopShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">): MenuCommand | undefined {
  if (event.isComposing || event.altKey) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey) return key === "f11" ? "fullscreen" : undefined;
  if (key === "+" || key === "=") return "zoom-in";
  if (event.shiftKey) return key === "n" ? "new-task" : key === "i" ? "devtools" : undefined;
  const shortcuts: Partial<Record<string, MenuCommand>> = { o: "open-project", ",": "settings", r: "reload", "-": "zoom-out", "0": "zoom-reset", q: "quit" };
  return shortcuts[key];
}

interface DesktopWindow {
  webContents: { undo(): void; redo(): void; cut(): void; copy(): void; paste(): void; selectAll(): void; reload(): void; toggleDevTools(): void; getZoomLevel(): number; setZoomLevel(level: number): void };
  minimize(): void; isMaximized(): boolean; maximize(): void; unmaximize(): void;
  isFullScreen(): boolean; setFullScreen(value: boolean): void; close(): void;
}

// Explicit dispatch: the renderer cannot select arbitrary BrowserWindow methods.
export function runDesktopCommand(target: DesktopWindow, command: unknown): void {
  const contents = target.webContents;
  switch (command) {
    case "undo": contents.undo(); break;
    case "redo": contents.redo(); break;
    case "cut": contents.cut(); break;
    case "copy": contents.copy(); break;
    case "paste": contents.paste(); break;
    case "select-all": contents.selectAll(); break;
    case "reload": contents.reload(); break;
    case "devtools": contents.toggleDevTools(); break;
    case "zoom-in": contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + .5)); break;
    case "zoom-out": contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - .5)); break;
    case "zoom-reset": contents.setZoomLevel(0); break;
    case "fullscreen": target.setFullScreen(!target.isFullScreen()); break;
    case "minimize": target.minimize(); break;
    case "maximize": if (target.isMaximized()) target.unmaximize(); else target.maximize(); break;
    case "close": target.close(); break;
    default: throw new Error("不支持的窗口操作");
  }
}
