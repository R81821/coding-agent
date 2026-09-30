import React, { useEffect, useState } from "react";
import { ChevronDown, Copy, Download } from "lucide-react";
import type { ThemeId } from "../../theme.js";
import {
  activeVisualStyle,
  DEFAULT_APPEARANCE,
  setSeparateModes,
  visualColors,
  type AppearanceMode,
  type FontId,
  type VisualStyle,
} from "../../appearance.js";
import type { AppearanceController } from "../../use-appearance.js";
import { SettingsRow, SettingsSection } from "./SettingsSection.js";
import {
  ColorControl,
  FontSelect,
  Segments,
  SizeControl,
  Switch,
  WeightSelect,
} from "./AppearanceControls.js";

export function AppearanceSettings({
  theme,
  onThemeChange,
  themeSaved,
  appearance,
}: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  themeSaved: boolean;
  appearance: AppearanceController;
}) {
  const { preferences: prefs, update, mode, saved } = appearance;
  const [editMode, setEditMode] = useState<AppearanceMode>(mode);
  const [message, setMessage] = useState("");
  useEffect(() => setEditMode(mode), [mode]);
  const target = prefs.separateModes ? editMode : mode;
  const visual = activeVisualStyle(prefs, target);
  const colors = visualColors(visual, target);
  function setVisual(change: Partial<VisualStyle>) {
    const key = prefs.separateModes ? target : "shared";
    update({ ...prefs, [key]: { ...visual, ...change } });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ mode: theme, appearance: prefs }, null, 2),
      );
      setMessage("外观配置已复制");
    } catch {
      setMessage("复制失败，请重试");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ mode: theme, appearance: prefs }, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "harness-appearance.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("外观配置已导出");
  }
  return (
    <div className="appearance-settings">
      <SettingsSection title="视觉风格">
        <SettingsRow title="模式">
          <div className="appearance-modes" role="group" aria-label="界面模式">
            {(
              [
                { id: "system", label: "跟随系统" },
                { id: "kelo", label: "浅色" },
                { id: "classic", label: "深色" },
              ] as const
            ).map((item) => (
              <button
                type="button"
                key={item.id}
                aria-label={item.label}
                aria-pressed={theme === item.id}
                onClick={() => onThemeChange(item.id)}
              >
                <span
                  className={`appearance-mode-preview mode-${item.id}`}
                  aria-hidden="true"
                >
                  <i />
                  <span>
                    <b />
                    <b />
                    <b />
                    <em />
                  </span>
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
      {prefs.separateModes && (
        <div className="appearance-mode-editor">
          <span>分别编辑</span>
          <Segments
            label="编辑的模式"
            value={editMode}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={setEditMode}
          />
          <small>
            {target === mode ? "当前模式，实时预览" : "切换到此模式时应用"}
          </small>
        </div>
      )}
      <div className="settings-panel appearance-panel">
        <SettingsRow title="主题">
          <div className="appearance-controls">
            <button
              type="button"
              className="appearance-icon-button"
              aria-label="导出外观配置"
              title="导出外观配置"
              onClick={download}
            >
              <Download size={18} />
            </button>
            <button
              type="button"
              className="appearance-icon-button"
              aria-label="复制外观配置"
              title="复制外观配置"
              onClick={() => void copy()}
            >
              <Copy size={18} />
            </button>
            <select
              aria-label="主题"
              value={visual.preset}
              onChange={(event) =>
                setVisual({
                  preset: event.target.value as VisualStyle["preset"],
                  accent: "",
                  background: "",
                  foreground: "",
                })
              }
            >
              <option value="harness">Harness</option>
              <option value="graphite">石墨</option>
              <option value="ocean">海洋</option>
            </select>
          </div>
        </SettingsRow>
        <SettingsRow title="强调色">
          <div className="appearance-controls">
            <select
              aria-label="强调色预设"
              value={
                [
                  "",
                  "#ffffff",
                  "#2563eb",
                  "#a78bfa",
                  "#22c55e",
                  "#f59e0b",
                ].includes(visual.accent)
                  ? visual.accent
                  : "custom"
              }
              onChange={(event) => {
                if (event.target.value !== "custom")
                  setVisual({ accent: event.target.value });
              }}
            >
              <option value="">主题默认</option>
              <option value="#ffffff">白色</option>
              <option value="#2563eb">蓝色</option>
              <option value="#a78bfa">紫色</option>
              <option value="#22c55e">绿色</option>
              <option value="#f59e0b">橙色</option>
              <option value="custom">自定义</option>
            </select>
            <input
              className="appearance-accent-picker"
              type="color"
              aria-label="自定义强调色"
              value={colors.accent}
              onChange={(event) => setVisual({ accent: event.target.value })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title="背景">
          <ColorControl
            label="背景"
            value={colors.background}
            onChange={(background) => setVisual({ background })}
          />
        </SettingsRow>
        <SettingsRow title="前景">
          <ColorControl
            label="前景"
            value={colors.foreground}
            onChange={(foreground) => setVisual({ foreground })}
          />
        </SettingsRow>
        <SettingsRow title="字体">
          <FontSelect
            label="界面字体"
            value={visual.font}
            onChange={(font) => setVisual({ font: font as FontId })}
          />
        </SettingsRow>
      </div>
      <details className="appearance-advanced" open>
        <summary>
          高级
          <ChevronDown size={16} />
        </summary>
        <div className="settings-panel appearance-panel">
          <SettingsRow
            title="界面字号"
            description="调整界面和对话的基础字号（12–22 px）。"
          >
            <SizeControl
              label="界面字号"
              value={prefs.uiSize}
              min={12}
              max={22}
              onChange={(uiSize) => update({ ...prefs, uiSize })}
            />
          </SettingsRow>
          <SettingsRow
            title="代码字体大小"
            description="调整聊天和差异视图中代码使用的字号（10–24 px）。"
          >
            <SizeControl
              label="代码字体大小"
              value={prefs.codeSize}
              min={10}
              max={24}
              onChange={(codeSize) => update({ ...prefs, codeSize })}
            />
          </SettingsRow>
        </div>
        <div className="settings-panel appearance-panel">
          <SettingsRow
            title="减少动态效果"
            description="减少动画效果或匹配系统设置。"
          >
            <Segments
              label="减少动态效果"
              value={prefs.reducedMotion}
              options={[
                { value: "system", label: "系统" },
                { value: "on", label: "开启" },
                { value: "off", label: "关闭" },
              ]}
              onChange={(reducedMotion) => update({ ...prefs, reducedMotion })}
            />
          </SettingsRow>
          <SettingsRow
            title="分别设置浅色和深色模式"
            description="分别选择各自的主题、颜色和界面字体。"
          >
            <Switch
              label="分别设置浅色和深色模式"
              checked={prefs.separateModes}
              onChange={(separate) => {
                setEditMode(mode);
                update(setSeparateModes(prefs, separate, mode));
              }}
            />
          </SettingsRow>
        </div>
        <div className="settings-panel appearance-panel">
          <SettingsRow title="界面字体样式">
            <WeightSelect
              label="界面字体样式"
              value={prefs.uiWeight}
              onChange={(uiWeight) => update({ ...prefs, uiWeight })}
            />
          </SettingsRow>
          <SettingsRow title="内容字体">
            <div className="appearance-controls">
              <FontSelect
                label="内容字体"
                value={prefs.contentFont}
                inherit
                onChange={(contentFont) => update({ ...prefs, contentFont })}
              />
              <WeightSelect
                label="内容字体样式"
                value={prefs.contentWeight}
                onChange={(contentWeight) =>
                  update({ ...prefs, contentWeight })
                }
              />
            </div>
          </SettingsRow>
          <SettingsRow title="代码字体">
            <div className="appearance-controls">
              <FontSelect
                label="代码字体"
                value={prefs.codeFont}
                onChange={(codeFont) =>
                  update({ ...prefs, codeFont: codeFont as FontId })
                }
              />
              <WeightSelect
                label="代码字体样式"
                value={prefs.codeWeight}
                onChange={(codeWeight) => update({ ...prefs, codeWeight })}
              />
            </div>
          </SettingsRow>
          <SettingsRow title="半透明侧边栏">
            <Switch
              label="半透明侧边栏"
              checked={prefs.translucentSidebar}
              onChange={(translucentSidebar) =>
                update({ ...prefs, translucentSidebar })
              }
            />
          </SettingsRow>
          <SettingsRow title="对比度">
            <label className="appearance-contrast">
              <input
                aria-label="对比度"
                type="range"
                min={0}
                max={100}
                value={prefs.contrast}
                onChange={(event) =>
                  update({ ...prefs, contrast: Number(event.target.value) })
                }
              />
              <output>{prefs.contrast}</output>
            </label>
          </SettingsRow>
        </div>
        <div className="settings-panel appearance-panel">
          <SettingsRow
            title="差异标记"
            description="使用颜色或 +/− 标记显示代码更改。"
          >
            <Segments
              label="差异标记"
              value={prefs.diffMarkers}
              options={[
                { value: "color", label: "颜色" },
                { value: "symbols", label: "+/−" },
              ]}
              onChange={(diffMarkers) => update({ ...prefs, diffMarkers })}
            />
          </SettingsRow>
          <SettingsRow
            title="使用指针光标"
            description="悬停交互元素时切换为指针光标。"
          >
            <Switch
              label="使用指针光标"
              checked={prefs.pointerCursor}
              onChange={(pointerCursor) => update({ ...prefs, pointerCursor })}
            />
          </SettingsRow>
        </div>
      </details>
      <footer className="appearance-footer">
        <p role="status">
          {!saved || !themeSaved
            ? "当前外观仅在本次打开时生效，无法保存到设备。"
            : message || "更改立即生效并自动保存。"}
        </p>
        <button
          type="button"
          onClick={() => {
            update(DEFAULT_APPEARANCE);
            setMessage("外观自定义已恢复默认");
          }}
        >
          恢复默认外观
        </button>
      </footer>
    </div>
  );
}
