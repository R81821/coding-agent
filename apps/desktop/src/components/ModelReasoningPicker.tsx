import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, LoaderCircle } from "lucide-react";
import type { ModelDescriptor, ReasoningEffort } from "@harness/protocol";
import "./ModelReasoningPicker.css";

export interface ModelReasoningPickerProps {
  model: ModelDescriptor | undefined;
  effort: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
}

const effortLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Ultra", max: "Ultra",
};
const rankedEfforts: ReasoningEffort[] = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return effortLabels[effort];
}

export function reasoningOptions(model: ModelDescriptor | undefined): ReasoningEffort[] {
  const supported = new Set(model?.capabilities.reasoningEfforts ?? []);
  return rankedEfforts.filter(effort => supported.has(effort));
}

export interface ReasoningUiOption {
  label: "Ultra" | "High" | "Medium" | "Low";
  value: ReasoningEffort;
  supported: boolean;
}

export function reasoningUiOptions(model: ModelDescriptor | undefined): ReasoningUiOption[] {
  const supported = new Set(reasoningOptions(model));
  const ultra: ReasoningEffort = supported.has("xhigh") ? "xhigh" : supported.has("max") ? "max" : "xhigh";
  return [
    { label: "Ultra", value: ultra, supported: supported.has(ultra) && model?.healthy === true },
    { label: "High", value: "high", supported: supported.has("high") && model?.healthy === true },
    { label: "Medium", value: "medium", supported: supported.has("medium") && model?.healthy === true },
    { label: "Low", value: "low", supported: supported.has("low") && model?.healthy === true },
  ];
}

export function modelDisplayName(model: Pick<ModelDescriptor, "modelId">): string {
  return model.modelId;
}

/** The entire popup is this wedge; model choice remains in provider settings. */
export function ReasoningTriangle({ model, effort, onChange }: Pick<ModelReasoningPickerProps, "model" | "effort" | "onChange">) {
  const clipId = `reasoning-triangle-${useId().replace(/:/g, "")}`;
  return <>
    <svg className="model-reasoning-clip-definition" width="0" height="0" aria-hidden="true" focusable="false">
      <defs><clipPath id={clipId} clipPathUnits="objectBoundingBox">
        <path d="M .064 0 H .936 Q .982 0 .961 .043 L .523 .956 Q .5 1 .477 .956 L .039 .043 Q .018 0 .064 0 Z" />
      </clipPath></defs>
    </svg>
    <div className="model-reasoning-triangle" role="radiogroup" aria-label="推理等级" style={{ clipPath: `url(#${clipId})` }}>
    <div className="model-reasoning-meteors" aria-hidden="true">
      <i className="model-reasoning-meteor" /><i className="model-reasoning-meteor" /><i className="model-reasoning-meteor" />
    </div>
    {reasoningUiOptions(model).map(({ value, label, supported }, index) => <button type="button" role="radio" disabled={!supported} aria-checked={supported && (effort === value || label === "Ultra" && (effort === "max" || effort === "xhigh"))} aria-label={`推理等级 ${label}`} key={label}
      title={!supported ? `当前模型不支持 ${label}` : undefined} className="model-reasoning-tier" style={{ "--tier-index": index } as React.CSSProperties} onClick={() => onChange(value)}>
      <span>{label}</span>
    </button>)}
    </div>
  </>;
}

export function ModelReasoningPicker({ model, effort, onChange, disabled = false, disabledReason, loading = false, error }: ModelReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: "hidden" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const modelName = model ? modelDisplayName(model) : loading ? "读取模型…" : "模型未配置";
  const effortName = effort === null ? "推理" : reasoningEffortLabel(effort);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const show = () => {
    if (disabled || loading) return;
    setPosition({ visibility: "hidden", width: Math.min(176, window.innerWidth - 24) });
    setOpen(true);
  };

  useEffect(() => { if (disabled || loading) setOpen(false); }, [disabled, loading]);
  useLayoutEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(176, window.innerWidth - 24);
      const starters = document.querySelector<HTMLElement>(".task-starters");
      const startersBounds = starters?.getBoundingClientRect();
      const cardsBottom = startersBounds && startersBounds.height > 0 ? startersBounds.bottom : undefined;
      const preferredHeight = Math.min(160, window.innerHeight - 24);
      let panelHeight = preferredHeight;
      let top = Math.max(12, anchor.top - panelHeight - 10);
      if (cardsBottom !== undefined) {
        const gap = anchor.top - cardsBottom - 12;
        if (gap >= 88) {
          panelHeight = Math.min(preferredHeight, gap);
          top = anchor.top - panelHeight - 10;
        } else {
          top = cardsBottom + 2;
          panelHeight = Math.max(4, Math.min(preferredHeight, window.innerHeight - top - 12));
        }
      }
      const center = anchor.left + anchor.width / 2;
      setPosition({ width, left: Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12)), top, "--triangle-height": `${panelHeight}px` } as React.CSSProperties);
    };
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(positionPanel);
    for (const element of [triggerRef.current, document.querySelector(".task-starters"), triggerRef.current?.closest(".composer-wrap"), document.querySelector(".conversation-stage")]) {
      if (element) observer?.observe(element);
    }
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
      observer?.disconnect();
    };
  }, [open, model]);
  useEffect(() => {
    if (!open || position.visibility === "hidden") return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? panel)?.focus();
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node | null;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open, position.visibility]);

  return <>
    <button ref={triggerRef} type="button" className="model-reasoning-trigger" disabled={disabled || loading} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={`模型与推理等级：${modelName}，${effortName}`} title={disabled ? disabledReason ?? "运行期间不能更改推理等级" : error || `${modelName} · ${effortName}`}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); } }}>
      <span className="model-reasoning-current-model">{modelName}</span><span className="model-reasoning-current-effort">{effortName}</span>
      {loading ? <LoaderCircle size={13} className="model-reasoning-spinner" aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
    </button>
    {open && typeof document !== "undefined" && createPortal(<div id={menuId} ref={panelRef} style={position} className="model-reasoning-popover" role="dialog" aria-label="选择推理等级" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === "Tab") event.stopPropagation();
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
        const index = items.indexOf(event.target as HTMLButtonElement);
        if (index < 0 || !items.length) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <ReasoningTriangle model={model} effort={effort} onChange={value => { onChange(value); close(true); }} />
    </div>, document.body)}
  </>;
}
