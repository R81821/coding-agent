import { resolveTheme, type ThemeId } from "./theme.js";

export type AppearanceMode = "light" | "dark";
export type FontId = "system" | "sans" | "serif" | "mono";
export type FontWeight = "regular" | "medium" | "bold";
export type VisualStyle = {
  preset: "harness" | "graphite" | "ocean";
  accent: string;
  background: string;
  foreground: string;
  font: FontId;
};
export type AppearancePreferences = {
  shared: VisualStyle;
  light: VisualStyle;
  dark: VisualStyle;
  separateModes: boolean;
  uiSize: number;
  codeSize: number;
  reducedMotion: "system" | "on" | "off";
  uiWeight: FontWeight;
  contentFont: FontId | "inherit";
  contentWeight: FontWeight;
  codeFont: FontId;
  codeWeight: FontWeight;
  translucentSidebar: boolean;
  contrast: number;
  diffMarkers: "color" | "symbols";
  pointerCursor: boolean;
};
const STYLE: VisualStyle = {
  preset: "harness",
  accent: "",
  background: "",
  foreground: "",
  font: "system",
};
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  shared: { ...STYLE },
  light: { ...STYLE },
  dark: { ...STYLE },
  separateModes: false,
  uiSize: 14,
  codeSize: 12,
  reducedMotion: "system",
  uiWeight: "regular",
  contentFont: "inherit",
  contentWeight: "regular",
  codeFont: "mono",
  codeWeight: "regular",
  translucentSidebar: true,
  contrast: 60,
  diffMarkers: "color",
  pointerCursor: false,
};
export const APPEARANCE_STORAGE_KEY = "harness.appearance.preferences.v1";
export const FONT_FAMILIES: Record<FontId, string> = {
  system: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  sans: 'Arial, "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Noto Serif CJK SC", SimSun, serif',
  mono: '"Cascadia Code", Consolas, "Microsoft YaHei", monospace',
};
const WEIGHTS: Record<FontWeight, string> = {
  regular: "400",
  medium: "500",
  bold: "700",
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function choice<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return options.includes(value as T) ? (value as T) : fallback;
}
function number(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}
export function isAppearanceColor(value: string): boolean {
  return /^#[\da-f]{6}$/i.test(value);
}
function style(value: unknown): VisualStyle {
  const input = record(value);
  const color = (key: string) =>
    typeof input[key] === "string" && isAppearanceColor(input[key])
      ? input[key]
      : "";
  return {
    preset: choice(input.preset, ["harness", "graphite", "ocean"], "harness"),
    accent: color("accent"),
    background: color("background"),
    foreground: color("foreground"),
    font: choice(input.font, ["system", "sans", "serif", "mono"], "system"),
  };
}
export function normalizeAppearance(value: unknown): AppearancePreferences {
  const input = record(value);
  return {
    shared: style(input.shared),
    light: style(input.light),
    dark: style(input.dark),
    separateModes: input.separateModes === true,
    uiSize: number(input.uiSize, 14, 12, 22),
    codeSize: number(input.codeSize, 12, 10, 24),
    reducedMotion: choice(
      input.reducedMotion,
      ["system", "on", "off"],
      "system",
    ),
    uiWeight: choice(input.uiWeight, ["regular", "medium", "bold"], "regular"),
    contentFont: choice(
      input.contentFont,
      ["inherit", "system", "sans", "serif", "mono"],
      "inherit",
    ),
    contentWeight: choice(
      input.contentWeight,
      ["regular", "medium", "bold"],
      "regular",
    ),
    codeFont: choice(
      input.codeFont,
      ["system", "sans", "serif", "mono"],
      "mono",
    ),
    codeWeight: choice(
      input.codeWeight,
      ["regular", "medium", "bold"],
      "regular",
    ),
    translucentSidebar: input.translucentSidebar !== false,
    contrast: number(input.contrast, 60, 0, 100),
    diffMarkers: choice(input.diffMarkers, ["color", "symbols"], "color"),
    pointerCursor: input.pointerCursor === true,
  };
}
export function readAppearance(): AppearancePreferences {
  try {
    return normalizeAppearance(
      JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return normalizeAppearance(null);
  }
}
export function saveAppearance(preferences: AppearancePreferences): boolean {
  try {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(preferences),
    );
    return true;
  } catch {
    return false;
  }
}
export function appearanceMode(
  theme: ThemeId,
  systemDark: boolean,
): AppearanceMode {
  return resolveTheme(theme, systemDark) === "classic" ? "dark" : "light";
}
export function activeVisualStyle(
  preferences: AppearancePreferences,
  mode: AppearanceMode,
): VisualStyle {
  return preferences.separateModes ? preferences[mode] : preferences.shared;
}
export function setSeparateModes(
  preferences: AppearancePreferences,
  separate: boolean,
  mode: AppearanceMode,
): AppearancePreferences {
  if (separate === preferences.separateModes) return preferences;
  return separate
    ? {
        ...preferences,
        separateModes: true,
        light: { ...preferences.shared },
        dark: { ...preferences.shared },
      }
    : {
        ...preferences,
        separateModes: false,
        shared: { ...preferences[mode] },
      };
}
export function visualColors(visual: VisualStyle, mode: AppearanceMode) {
  const dark = mode === "dark";
  const presets = {
    harness: {
      background: dark ? "#191919" : "#ffffff",
      foreground: dark ? "#f5f3f7" : "#242833",
      accent: dark ? "#b397d8" : "#555ee8",
    },
    graphite: {
      background: dark ? "#181818" : "#fafafa",
      foreground: dark ? "#ffffff" : "#202020",
      accent: dark ? "#ffffff" : "#353535",
    },
    ocean: {
      background: dark ? "#111b27" : "#f5f9ff",
      foreground: dark ? "#e6efff" : "#16314d",
      accent: dark ? "#70b7ff" : "#2563eb",
    },
  };
  const base = presets[visual.preset];
  return {
    background: visual.background || base.background,
    foreground: visual.foreground || base.foreground,
    accent: visual.accent || base.accent,
  };
}
export function applyAppearance(
  preferences: AppearancePreferences,
  mode: AppearanceMode,
  systemReducedMotion: boolean,
): void {
  const root = document.documentElement;
  const visual = activeVisualStyle(preferences, mode);
  const colors = visualColors(visual, mode);
  const rgb = [1, 3, 5].map((index) =>
    parseInt(colors.accent.slice(index, index + 2), 16),
  );
  const onAccent =
    rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114 > 160
      ? "#161616"
      : "#ffffff";
  const backgroundRgb = [1, 3, 5].map((index) =>
    parseInt(colors.background.slice(index, index + 2), 16),
  );
  const tone =
    backgroundRgb[0]! * 0.299 +
      backgroundRgb[1]! * 0.587 +
      backgroundRgb[2]! * 0.114 >
    160
      ? "light"
      : "dark";
  root.style.setProperty("color-scheme", tone);
  root.dataset.appearanceTone = tone;
  const variables: Record<string, string> = {
    "--appearance-bg": colors.background,
    "--appearance-fg": colors.foreground,
    "--appearance-accent": colors.accent,
    "--appearance-on-accent": onAccent,
    "--appearance-muted": `color-mix(in srgb, ${colors.foreground} ${45 + preferences.contrast * 0.4}%, ${colors.background})`,
    "--appearance-line": `color-mix(in srgb, ${colors.foreground} ${8 + preferences.contrast * 0.2}%, ${colors.background})`,
    "--ui-font": FONT_FAMILIES[visual.font],
    "--content-font":
      FONT_FAMILIES[
        preferences.contentFont === "inherit"
          ? visual.font
          : preferences.contentFont
      ],
    "--code-font": FONT_FAMILIES[preferences.codeFont],
    "--ui-font-size": `${preferences.uiSize}px`,
    "--code-font-size": `${preferences.codeSize}px`,
    "--ui-font-weight": WEIGHTS[preferences.uiWeight],
    "--content-font-weight": WEIGHTS[preferences.contentWeight],
    "--code-font-weight": WEIGHTS[preferences.codeWeight],
  };
  for (const [name, value] of Object.entries(variables))
    root.style.setProperty(name, value);
  root.dataset.appearance = "custom";
  root.dataset.reducedMotion = String(
    preferences.reducedMotion === "system"
      ? systemReducedMotion
      : preferences.reducedMotion === "on",
  );
  root.dataset.translucentSidebar = String(preferences.translucentSidebar);
  root.dataset.diffMarkers = preferences.diffMarkers;
  root.dataset.pointerCursor = String(preferences.pointerCursor);
}
