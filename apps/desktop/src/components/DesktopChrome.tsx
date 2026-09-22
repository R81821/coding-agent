import React, { useEffect, useRef, useState } from "react";
import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, FolderOpen, SquarePen, Settings, LogOut, RefreshCw, ZoomIn, ZoomOut, Scan, Code2, Minus, Maximize2, X, Info, CheckCheck, RotateCcw } from "lucide-react";
import { desktopShortcut, type MenuCommand } from "../desktop-menu.js";
import "./desktop-chrome.css";

const menus = [
  { label: "文件", items: [
    { command: "new-task", label: "新建任务", shortcut: "Ctrl+Shift+N", icon: SquarePen },
    { command: "open-project", label: "打开项目…", shortcut: "Ctrl+O", icon: FolderOpen },
    { command: "settings", label: "设置", shortcut: "Ctrl+,", icon: Settings, divider: true },
    { command: "quit", label: "退出应用", shortcut: "Ctrl+Q", icon: LogOut, divider: true },
  ] },
  { label: "编辑", items: [
    { command: "undo", label: "撤销", shortcut: "Ctrl+Z", icon: Undo2 },
    { command: "redo", label: "重做", shortcut: "Ctrl+Y", icon: Redo2 },
    { command: "cut", label: "剪切", shortcut: "Ctrl+X", icon: Scissors, divider: true },
    { command: "copy", label: "复制", shortcut: "Ctrl+C", icon: Copy },
    { command: "paste", label: "粘贴", shortcut: "Ctrl+V", icon: ClipboardPaste },
    { command: "select-all", label: "全选", shortcut: "Ctrl+A", icon: CheckCheck },
  ] },
  { label: "视图", items: [
    { command: "zoom-in", label: "放大", shortcut: "Ctrl++", icon: ZoomIn },
    { command: "zoom-out", label: "缩小", shortcut: "Ctrl+−", icon: ZoomOut },
    { command: "zoom-reset", label: "实际大小", shortcut: "Ctrl+0", icon: RotateCcw },
    { command: "fullscreen", label: "切换全屏", shortcut: "F11", icon: Scan, divider: true },
    { command: "reload", label: "重新加载", shortcut: "Ctrl+R", icon: RefreshCw, divider: true },
    { command: "devtools", label: "开发者工具", shortcut: "Ctrl+Shift+I", icon: Code2 },
  ] },
  { label: "窗口", items: [
    { command: "minimize", label: "最小化", icon: Minus },
    { command: "maximize", label: "最大化 / 还原", icon: Maximize2 },
    { command: "close", label: "收起到托盘", shortcut: "Alt+F4", icon: X, divider: true },
  ] },
  { label: "帮助", items: [{ command: "about", label: "关于 Harness", icon: Info }] },
] satisfies { label: string; items: { command: MenuCommand; label: string; shortcut?: string; icon: typeof Copy; divider?: boolean }[] }[];

export function DesktopChrome({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  const bar = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const menuButtons = () => [...(bar.current?.querySelectorAll<HTMLButtonElement>('[role="menubar"] > button') ?? [])];
  const items = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  function close(restore = false) {
    setOpen(null);
    if (restore) previousFocus.current?.focus();
  }
  function show(index: number) {
    if (!bar.current?.contains(document.activeElement)) previousFocus.current = document.activeElement as HTMLElement | null;
    setOpen(index);
  }
  async function execute(command: MenuCommand) {
    close(true);
    setError("");
    try {
      if (command === "new-task" || command === "open-project" || command === "settings") {
        window.dispatchEvent(new CustomEvent("harness:workspace-menu", { detail: command }));
      } else await window.harness.desktopCommand(command);
    } catch { setError("菜单操作失败，请重试。"); }
  }

  useEffect(() => {
    const syncTheme = () => { void window.harness.setTitlebarTheme(document.documentElement.dataset.theme === "kelo" ? "kelo" : "classic").catch(() => setError("窗口配色同步失败，请重新加载。")); };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A modal owns keyboard input until it is dismissed.
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "F10" && !event.shiftKey) {
        event.preventDefault();
        previousFocus.current = document.activeElement as HTMLElement | null;
        menuButtons()[0]?.focus();
        return;
      }
      const command = desktopShortcut(event);
      if (command) { event.preventDefault(); void execute(command); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open === null) return;
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) close(); };
    const blur = () => close();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("blur", blur); };
  }, [open]);

  return <div className={`desktop-frame${window.harness.desktopPlatform === "darwin" ? " desktop-mac" : ""}`}>
    <header className="desktop-menu-bar" ref={bar}>
      <span className="desktop-wordmark"><span>H</span>Harness</span>
      <nav role="menubar" aria-label="应用菜单" onKeyDown={(event) => {
        if (event.key === "Tab") close();
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Escape") { close(true); return; }
        const buttons = menuButtons();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? menus.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length;
        buttons[next]?.focus();
        if (open !== null) show(next);
      }}>
        {menus.map((menu, index) => <button key={menu.label} role="menuitem" aria-haspopup="menu" aria-expanded={open === index} aria-controls={`desktop-menu-${index}`} tabIndex={index === (open ?? 0) ? 0 : -1}
          onMouseDown={event => event.preventDefault()}
          onClick={() => open === index ? close(true) : show(index)}
          onPointerEnter={() => { if (open !== null) show(index); }}
          onKeyDown={event => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(index); requestAnimationFrame(() => (event.key === "ArrowUp" ? items().at(-1) : items()[0])?.focus()); } }}>
          {menu.label}
        </button>)}
      </nav>
      <div className="desktop-drag-space" aria-hidden="true" />
      {open !== null && <div ref={panel} id={`desktop-menu-${open}`} className="desktop-menu-popup" role="menu" aria-label={menus[open]!.label} style={{ left: `${116 + open * 48}px` }} onKeyDown={event => {
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          list[event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
        } else if (event.key === "Escape") { event.preventDefault(); close(); menuButtons()[open]?.focus(); }
        else if (event.key === "Tab") close();
        else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          show((open + (event.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length);
          requestAnimationFrame(() => items()[0]?.focus());
        }
      }}>
        {menus[open]!.items.map(item => <React.Fragment key={item.command}>
          {"divider" in item && item.divider && <div className="desktop-menu-divider" role="separator" />}
          <button role="menuitem" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => void execute(item.command)}>
            <item.icon size={16} aria-hidden="true" /><span>{item.label}</span>{"shortcut" in item && <kbd>{item.shortcut}</kbd>}
          </button>
        </React.Fragment>)}
      </div>}
      {error && <button className="desktop-menu-error" role="alert" onClick={() => setError("")}>{error}</button>}
    </header>
    <div className="desktop-body">{children}</div>
  </div>;
}
