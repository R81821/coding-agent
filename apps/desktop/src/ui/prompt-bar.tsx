import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Check, Plus, ListChecks, Hammer, Sparkles, Square } from "lucide-react";
import { shouldSubmitComposerKey } from "../composer-keys.js";
import "./prompt-bar.css";

type TaskMode = "auto" | "analysis" | "change";
const modes = [
  { value: "analysis", label: "Plan", icon: ListChecks },
  { value: "change", label: "Build", icon: Hammer },
  { value: "auto", label: "Auto", icon: Sparkles },
] as const;

/**
 * One control for the three things a composer can do, chosen by what the user has in hand. Typing
 * always wins: text is submitted (a steering note while a run is active, otherwise a new task), so
 * the button never parks a run the moment someone starts a correction. With nothing typed it takes
 * on the run's own state — pause while working, continue once parked.
 */
function TrailingAction({ locked, runLocked, hasText, busy, onHold, holding, onRelease, canRelease, onSubmit }: {
  /** Blocks submitting text: the composer is unavailable or idle. */
  locked: boolean;
  /**
   * Blocks the run controls. Deliberately not `locked`: a run is busy precisely while it can be
   * paused, so gating pause on the busy flag disables the button exactly when it is needed.
   */
  runLocked: boolean;
  hasText: boolean;
  busy: boolean;
  onHold?: (() => void) | undefined;
  holding?: boolean | undefined;
  onRelease?: (() => void) | undefined;
  canRelease?: boolean | undefined;
  onSubmit: () => void;
}) {
  if (hasText) {
    return (
      <button type="button" className="prompt-send" disabled={locked} aria-label={busy ? "发送补充说明" : "发送"}
        title={busy ? "发送补充说明，将在下一个回合边界读取" : "发送"} onClick={onSubmit}>
        <ArrowUp size={20} aria-hidden="true" />
      </button>
    );
  }
  if (holding && onRelease) {
    return (
      <button type="button" className="prompt-send is-holding" disabled={runLocked || canRelease === false}
        aria-label="继续" title="继续运行" onClick={onRelease}>
        <ArrowUp size={20} aria-hidden="true" />
      </button>
    );
  }
  if (busy && onHold) {
    return (
      <button type="button" className="prompt-send is-running" disabled={runLocked}
        aria-label="暂停" title="在下一个回合边界暂停" onClick={onHold}>
        <Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className="prompt-send" disabled aria-label="发送">
      <ArrowUp size={20} aria-hidden="true" />
    </button>
  );
}

export function BuiPromptBar({ value, onChange, onSubmit, placeholder, disabled, busy, taskMode = "auto", onTaskModeChange, attachments, actions, skillChips, skillPicker, onHold, holding, onRelease, canRelease, runDisabled = false }: {
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
  skillChips?: React.ReactNode;
  skillPicker?: React.ReactNode;
  /** Set while a run the caller can hold is active; makes the trailing control a pause button. */
  onHold?: () => void;
  /** True once the run has actually parked. The same control then resumes it. */
  holding?: boolean;
  onRelease?: () => void;
  canRelease?: boolean;
  /** Blocks the pause/continue control only. Defaults to `disabled`; never derived from `busy`. */
  runDisabled?: boolean;
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
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
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
      {skillChips}
      {skillPicker}
      {attachments && <div className="prompt-attachments">{attachments}</div>}
      {open && !disabled && <div id={menuId} className="prompt-add-panel" role="dialog" aria-label="添加内容与任务模式">
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
        <button ref={triggerRef} type="button" className="prompt-add" aria-label="添加内容" aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open && !disabled ? menuId : undefined} disabled={disabled} onClick={() => setOpen(!open)}><Plus size={21} aria-hidden="true" /></button>
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
          <TrailingAction
            locked={locked}
            runLocked={runDisabled || disabled}
            hasText={Boolean(value.trim())}
            busy={busy}
            onHold={onHold}
            holding={holding}
            onRelease={onRelease}
            canRelease={canRelease}
            onSubmit={onSubmit}
          />
        </div>
      </div>
    </div>
  );
}
