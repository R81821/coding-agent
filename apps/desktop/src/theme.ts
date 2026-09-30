export const THEMES = [
  { id: "classic", name: "经典深色", description: "柔和炭灰与淡紫，熟悉的专注工作台。" },
  { id: "kelo", name: "Kelo 玻璃", description: "明亮背景、轻盈面板与柔和的玻璃层次。" },
  { id: "system", name: "跟随系统", description: "根据系统设置，自动切换浅色与深色外观。" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
export type ResolvedThemeId = Exclude<ThemeId, "system">;
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
export function resolveTheme(theme: ThemeId, prefersDark: boolean): ResolvedThemeId {
  return theme === "system" ? (prefersDark ? "classic" : "kelo") : theme;
}
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = resolveTheme(theme, theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
export function watchTheme(theme: ThemeId): () => void {
  applyTheme(theme);
  if (theme !== "system") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => { document.documentElement.dataset.theme = resolveTheme(theme, media.matches); };
  sync();
  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
}
export function saveTheme(theme: ThemeId): boolean {
  applyTheme(theme);
  try { window.localStorage.setItem(STORAGE_KEY, theme); return true; }
  catch { return false; }
}
