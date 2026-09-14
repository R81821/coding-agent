import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Plus, ListChecks, Hammer, Sparkles } from "lucide-react";
import { shouldSubmitComposerKey } from "../composer-keys.js";
import "./prompt-bar.css";

type TaskMode = "auto" | "analysis" | "change";
const modes = [
  { value: "analysis", label: "Plan", icon: ListChecks },
  { value: "change", label: "Build", icon: Hammer },
  { value: "auto", label: "Auto", icon: Sparkles },
] as const;

export function BuiPromptBar({ value, onChange, onSubmit, placeholder, disabled, busy, taskMode = "auto", onTaskModeChange, attachments, actions }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled: boolean;
  busy: boolean;
  taskMode?: TaskMode;
  onTaskModeChange?: (mode: TaskMode) => void;
  attachments?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const locked = disabled || busy;
  const current = modes.find(mode => mode.value === taskMode)!;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 40), 168)}px`;
  }, [value]);
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.getElementById(menuId)?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open, menuId]);

  return (
    <div className="workbench-prompt prompt-compact" ref={shellRef}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === "Escape" && open) {
          event.preventDefault(); setOpen(false); triggerRef.current?.focus();
        }
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && onTaskModeChange && !locked) {
          event.preventDefault();
          onTaskModeChange(modes[(modes.findIndex(mode => mode.value === taskMode) + 1) % modes.length]!.value);
        }
      }}>
      {attachments && <div className="prompt-attachments">{attachments}</div>}
      {open && !locked && <div id={menuId} className="prompt-add-panel" role="dialog" aria-label="添加内容与任务模式">
        {actions && <div className="prompt-add-files" onClick={event => {
          const button = (event.target as Element).closest("button");
          if (button && !button.disabled) { setOpen(false); textareaRef.current?.focus(); }
        }}>{actions}</div>}
        {onTaskModeChange && <div className="prompt-mode-options" role="group" aria-label="任务模式">
          {modes.map(mode => <button type="button" key={mode.value} aria-pressed={taskMode === mode.value} disabled={locked}
            onClick={() => { onTaskModeChange(mode.value); setOpen(false); textareaRef.current?.focus(); }}>
            <mode.icon size={19} aria-hidden="true" /><strong className={`mode-${mode.value}`}>{mode.label}</strong>
            {taskMode === mode.value && <Check size={17} className="prompt-mode-check" aria-hidden="true" />}
          </button>)}
        </div>}
      </div>}
      <div className="prompt-compose-row">
        <button ref={triggerRef} type="button" className="prompt-add" aria-label="添加内容" aria-haspopup="dialog" aria-expanded={open && !locked} aria-controls={open && !locked ? menuId : undefined} disabled={locked} onClick={() => setOpen(!open)}><Plus size={21} aria-hidden="true" /></button>
        <textarea ref={textareaRef} rows={1} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} disabled={disabled}
          aria-label="向 Harness Agent 发送消息" className="prompt-textarea"
          onKeyDown={event => {
            if (shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
              event.preventDefault();
              if (!locked && value.trim()) onSubmit();
            }
          }} />
        <div className="prompt-meta">
          {onTaskModeChange && <span className={`prompt-current-mode mode-${current.value}`} aria-live="polite">{current.label}</span>}
          <button type="button" className="prompt-send" disabled={locked || !value.trim()} aria-label={busy ? "正在运行" : "发送"} title={busy ? "正在运行" : "发送"} onClick={onSubmit}>
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}
