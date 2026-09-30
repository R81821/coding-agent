import React, { useEffect, useState } from "react";
import {
  isAppearanceColor,
  type FontId,
  type FontWeight,
} from "../../appearance.js";

const FONTS: { value: FontId; label: string }[] = [
  { value: "system", label: "系统" },
  { value: "sans", label: "无衬线" },
  { value: "serif", label: "衬线" },
  { value: "mono", label: "等宽" },
];
export function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="appearance-segments" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="appearance-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function FontSelect({
  label,
  value,
  onChange,
  inherit = false,
}: {
  label: string;
  value: FontId | "inherit";
  onChange: (value: FontId | "inherit") => void;
  inherit?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as FontId | "inherit")}
    >
      {inherit && <option value="inherit">与界面字体相同</option>}
      {FONTS.map((font) => (
        <option key={font.value} value={font.value}>
          {font.label}
        </option>
      ))}
    </select>
  );
}
export function WeightSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FontWeight;
  onChange: (value: FontWeight) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as FontWeight)}
    >
      <option value="regular">常规</option>
      <option value="medium">中等</option>
      <option value="bold">粗体</option>
    </select>
  );
}
export function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isAppearanceColor(draft);
  return (
    <div className="appearance-color">
      <input
        type="color"
        aria-label={`${label}选择器`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        type="text"
        aria-label={`${label}色值`}
        aria-invalid={!valid}
        value={draft}
        maxLength={7}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          if (isAppearanceColor(event.target.value))
            onChange(event.target.value);
        }}
        onBlur={() => {
          if (!valid) setDraft(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(value);
        }}
      />
    </div>
  );
}
export function SizeControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="appearance-size">
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (
            event.target.value &&
            Number.isInteger(next) &&
            next >= min &&
            next <= max
          )
            onChange(next);
        }}
        onBlur={() => setDraft(String(value))}
      />
      <span>px</span>
    </label>
  );
}
