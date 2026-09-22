import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Plus, X, Globe2, Download, Loader2 } from "lucide-react";
import type { BrowserState, BrowserAction } from "@harness/protocol";
import "./browser-panel.css";

export function BrowserPanel({ sessionId, open, onOpenChange }: { sessionId: string | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<BrowserState>();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [transfers, setTransfers] = useState(false);
  const [width, setWidth] = useState(() => { try { const value = Number(localStorage.getItem("harness.browser.width")); return value >= 340 && value <= 900 ? value : 440; } catch { return 440; } });
  const viewport = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const active = state?.tabs.find(tab => tab.id === state.activeTabId);
  useEffect(() => { setAddress(active?.url === "about:blank" ? "" : active?.url ?? ""); }, [active?.url, active?.id]);
  useEffect(() => {
    const current = ++generation.current; setState(undefined); setError("");
    let seenReveal = 0;
    const receive = (value: BrowserState) => { if (generation.current === current && value.sessionId === sessionId) { setState(value); if (value.revealVersion > seenReveal && value.visible) onOpenChange(true); seenReveal = value.revealVersion; } };
    const remove = window.harness.onBrowserState(receive);
    if (sessionId) void window.harness.browserState(sessionId).then(receive).catch(error => { if (generation.current === current) setError(String(error)); });
    return () => { generation.current++; remove(); };
  }, [sessionId, onOpenChange]);

  const command = useCallback(async (input: BrowserAction) => {
    if (!sessionId) return;
    setError("");
    try { await window.harness.browserCommand(sessionId, input); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, [sessionId]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = viewport.current?.getBoundingClientRect();
        const obscured = Boolean(document.querySelector('dialog[open], [role="menu"], .approval-overlay, .crop-overlay'));
        void window.harness.browserLayout({ sessionId: sessionId ?? null, visible: open, obscured, x: rect?.x ?? 0, y: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 }).catch(() => {});
      });
    };
    const resize = new ResizeObserver(update); if (viewport.current) resize.observe(viewport.current);
    const mutations = new MutationObserver(update); mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "style"] });
    window.addEventListener("resize", update); update();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); };
  }, [sessionId, open, transfers, active?.id, error]);
  useEffect(() => {
    document.documentElement.style.setProperty("--browser-width", `${width}px`);
    try { localStorage.setItem("harness.browser.width", String(width)); } catch { /* Width is optional. */ }
  }, [width]);
  useEffect(() => () => { void window.harness.browserLayout({ sessionId: null, visible: false, obscured: false, x: 0, y: 0, width: 0, height: 0 }).catch(() => {}); }, []);

  if (!open) return null;
  return <>
    <div className="browser-resizer" role="separator" aria-label="调整浏览器宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setWidth(value => Math.max(340, Math.min(Math.min(900, window.innerWidth - 350), value + (event.key === "ArrowLeft" ? 20 : -20)))); } }} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(340, Math.min(Math.min(900, window.innerWidth - 350), window.innerWidth - event.clientX - 10))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
    <aside className="browser-panel" aria-label="内置浏览器">
      <header className="browser-panel-heading"><Globe2 size={16} /><strong>浏览器</strong><small>当前对话独立登录</small><button title="下载记录" aria-label="下载记录" onClick={() => setTransfers(value => !value)}><Download size={16} /></button><button aria-label="收起浏览器" title="收起浏览器" onClick={() => onOpenChange(false)}><X size={16} /></button></header>
      <div className="browser-tab-strip" role="tablist" aria-label="网页标签">
        {state?.tabs.map(tab => <div className={`browser-tab${tab.id === active?.id ? " active" : ""}`} key={tab.id}><button role="tab" aria-selected={tab.id === active?.id} title={tab.title} onClick={() => void command({ action: "switch_tab", tabId: tab.id })}>{tab.loading ? <Loader2 className="browser-spin" size={13} /> : <Globe2 size={13} />}<span>{tab.title}</span></button><button aria-label={`关闭 ${tab.title}`} onClick={() => void command({ action: "close_tab", tabId: tab.id })}><X size={12} /></button></div>)}
        <button aria-label="新标签页" title="新标签页" disabled={!sessionId} onClick={() => void command({ action: "new_tab" })}><Plus size={16} /></button>
      </div>
      <form className="browser-address-bar" onSubmit={event => { event.preventDefault(); const value = address.trim(); if (value) void command(active ? { action: "navigate", tabId: active.id, url: /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}` } : { action: "new_tab", url: /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}` }); }}>
        <button type="button" aria-label="后退" disabled={!active?.canGoBack} onClick={() => active && void command({ action: "back", tabId: active.id })}><ArrowLeft size={15} /></button>
        <button type="button" aria-label="前进" disabled={!active?.canGoForward} onClick={() => active && void command({ action: "forward", tabId: active.id })}><ArrowRight size={15} /></button>
        <button type="button" aria-label="刷新网页" disabled={!active} onClick={() => active && void command({ action: "reload", tabId: active.id })}><RefreshCw size={15} /></button>
        <input aria-label="网页地址" placeholder="输入网址，按 Enter 打开" value={address} disabled={!sessionId} onChange={event => setAddress(event.target.value)} />
      </form>
      {(error || active?.error) && <div role="alert" className="browser-error">{error || active?.error}</div>}
      {transfers && <section className="browser-downloads" aria-label="下载列表">
        {!state?.downloads.length && <p>暂无下载</p>}
        {state?.downloads.map(item => <article key={item.id}><strong>{item.filename}</strong><small>{({ awaiting_confirmation: "等待确认保存", progressing: "下载中", completed: "已完成", cancelled: "已取消", interrupted: "下载失败" })[item.status]} · {Math.round(item.receivedBytes / 1024)} KB</small>{item.path && <small title={item.path}>{item.path}</small>}{item.error && <small>{item.error}</small>}{item.status === "awaiting_confirmation" && <button onClick={() => void command({ action: "download", tabId: item.tabId, url: item.url, filename: item.filename })}>保存到项目</button>}{item.status === "progressing" && <button onClick={() => void command({ action: "cancel_download", downloadId: item.id })}>取消</button>}</article>)}
      </section>}
      <div className="browser-viewport" ref={viewport}><div className="browser-empty"><Globe2 size={32} /><strong>{sessionId ? "在右侧浏览网页" : "先打开一个对话"}</strong><p>{sessionId ? "输入网址，或让 Agent 使用 browser 工具。" : "浏览器标签与网站登录状态按对话独立保存。"}</p></div></div>
    </aside>
  </>;
}
