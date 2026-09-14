import React from "react";
import { Check, Palette } from "lucide-react";
import { THEMES, type ThemeId } from "../theme.js";

export function ThemePicker({ value, onChange, saved }: { value: ThemeId; onChange: (theme: ThemeId) => void; saved: boolean }) {
  return (
    <article className="glass theme-settings">
      <div className="theme-settings-heading">
        <div><small>APPEARANCE</small><h3><Palette size={18} />外观</h3><p>选择工作台的样子，让每一次开始都更自在。</p></div>
        <span className="theme-status" role="status">{saved ? "选择自动保存" : "当前主题仅在本次打开时生效，无法保存到设备。"}</span>
      </div>
      <fieldset className="theme-options">
        <legend className="sr-only">选择界面主题</legend>
        {THEMES.map(theme => (
          <label key={theme.id} className={"theme-option " + (value === theme.id ? "is-selected" : "")}>
            <input type="radio" name="appearance-theme" value={theme.id} checked={value === theme.id} onChange={() => onChange(theme.id)} />
            <span className={"theme-preview theme-preview-" + theme.id} aria-hidden="true">
              <span className="theme-preview-nav"><i /><i /><i /><i /></span>
              <span className="theme-preview-workspace"><span className="theme-preview-title" /><span className="theme-preview-subtitle" /><span className="theme-preview-cards"><i /><i /><i /></span><span className="theme-preview-composer" /></span>
            </span>
            <span className="theme-option-caption"><span><strong>{theme.name}</strong><small>{theme.description}</small></span><span className="theme-check" aria-hidden="true">{value === theme.id && <Check size={15} />}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="theme-settings-note">立即切换 · 下次打开继续使用 · 无需重启</p>
    </article>
  );
}
