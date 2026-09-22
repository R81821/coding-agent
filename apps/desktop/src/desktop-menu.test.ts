import { describe, expect, it, vi } from "vitest";
import { desktopShortcut, runDesktopCommand } from "./desktop-menu.js";

const key = (key: string, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...modifiers });

describe("desktop menu shortcuts", () => {
  it("preserves editing and composer keyboard handling", () => {
    expect(desktopShortcut(key("c", { ctrlKey: true }))).toBeUndefined();
    expect(desktopShortcut(key("Tab", { shiftKey: true }))).toBeUndefined();
    expect(desktopShortcut(key("o"))).toBeUndefined();
    expect(desktopShortcut(key("o", { ctrlKey: true, isComposing: true }))).toBeUndefined();
  });
  it("supports project, settings and view shortcuts", () => {
    expect(desktopShortcut(key("o", { ctrlKey: true }))).toBe("open-project");
    expect(desktopShortcut(key(",", { ctrlKey: true }))).toBe("settings");
    expect(desktopShortcut(key("+", { ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
    expect(desktopShortcut(key("F11"))).toBe("fullscreen");
  });
});

describe("desktop command boundary", () => {
  function target() {
    return {
      webContents: { undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), reload: vi.fn(), toggleDevTools: vi.fn(), getZoomLevel: () => 0, setZoomLevel: vi.fn() },
      minimize: vi.fn(), isMaximized: () => false, maximize: vi.fn(), unmaximize: vi.fn(), isFullScreen: () => false, setFullScreen: vi.fn(), close: vi.fn(),
    };
  }
  it("rejects unknown renderer commands without invoking anything", () => {
    const win = target();
    expect(() => runDesktopCommand(win, "executeJavaScript")).toThrow();
    expect(() => runDesktopCommand(win, { action: "close" })).toThrow();
    expect(win.close).not.toHaveBeenCalled();
  });
  it("routes close through the existing window lifecycle", () => {
    const win = target();
    runDesktopCommand(win, "close");
    expect(win.close).toHaveBeenCalledOnce();
  });
  it("toggles maximize and full screen based on actual window state", () => {
    const win = target();
    runDesktopCommand(win, "maximize");
    expect(win.maximize).toHaveBeenCalledOnce();
    win.isMaximized = () => true;
    runDesktopCommand(win, "maximize");
    expect(win.unmaximize).toHaveBeenCalledOnce();
    runDesktopCommand(win, "fullscreen");
    expect(win.setFullScreen).toHaveBeenCalledWith(true);
  });
  it("bounds zoom so the menu remains usable", () => {
    const win = target();
    win.webContents.getZoomLevel = () => 3;
    runDesktopCommand(win, "zoom-in");
    expect(win.webContents.setZoomLevel).toHaveBeenLastCalledWith(3);
    win.webContents.getZoomLevel = () => -3;
    runDesktopCommand(win, "zoom-out");
    expect(win.webContents.setZoomLevel).toHaveBeenLastCalledWith(-3);
    runDesktopCommand(win, "zoom-reset");
    expect(win.webContents.setZoomLevel).toHaveBeenLastCalledWith(0);
  });
});
