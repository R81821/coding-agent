export const THEMES = [
  { id: "classic", name: "经典深色", description: "柔和炭灰与淡紫，熟悉的专注工作台。" },
  { id: "kelo", name: "Kelo 玻璃", description: "墨黑光晕、磨砂面板与清晰的白色层次。" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
const STORAGE_KEY = "harness.appearance.theme";
export function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some(theme => theme.id === value);
}
export function readTheme(): ThemeId {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(value) ? value : "classic";
  } catch { return "classic"; }
}
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}
export function saveTheme(theme: ThemeId): boolean {
  applyTheme(theme);
  try { window.localStorage.setItem(STORAGE_KEY, theme); return true; }
  catch { return false; }
}
