import React, { useEffect, useRef } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { shouldSubmitComposerKey } from "../composer-keys.js";

export function BuiPromptBar({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  busy,
  providerLabel,
  taskMode = "auto",
  onTaskModeChange,
  attachments,
  actions,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled: boolean;
  busy: boolean;
  providerLabel?: string;
  taskMode?: "auto" | "analysis" | "change";
  onTaskModeChange?: (mode: "auto" | "analysis" | "change") => void;
  attachments?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 64), 168)}px`;
  }, [value]);

  return (
    <div className="workbench-prompt">
      {attachments && <div className="prompt-attachments">{attachments}</div>}
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="向 Harness Agent 发送消息"
        className="prompt-textarea"
        onKeyDown={(event) => {
          if (
            shouldSubmitComposerKey({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            })
          ) {
            event.preventDefault();
            if (!disabled && value.trim()) onSubmit();
          }
        }}
      />
      <div className="prompt-toolbar">
        <div className="prompt-actions">{actions}{onTaskModeChange && <select aria-label="任务模式" title="自动判断、只读分析或修改代码" value={taskMode} disabled={disabled} onChange={event => onTaskModeChange(event.target.value as "auto" | "analysis" | "change")} className="rounded-lg border border-line bg-transparent px-2 py-1 text-xs text-text"><option value="auto">自动判断</option><option value="analysis">只读分析</option><option value="change">修改代码</option></select>}</div>
        <div className="prompt-meta">
          {providerLabel && (
            <span className="prompt-model" title={providerLabel}>{providerLabel}</span>
          )}
          <button
            type="button"
            className="prompt-send"
            disabled={disabled || !value.trim()}
            aria-label={busy ? "正在运行" : "发送"}
            title={busy ? "正在运行" : "发送"}
            onClick={onSubmit}
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp size={20} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div className="prompt-key-hint">Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}
