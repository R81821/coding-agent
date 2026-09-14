export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 258;

const storageKey = "harness.layout.sidebarWidth";

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));
}

export function readSidebarWidth(): number {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return value > 0 ? clampSidebarWidth(value) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveSidebarWidth(value: number): number {
  const next = clampSidebarWidth(value);
  try { localStorage.setItem(storageKey, String(next)); } catch { /* layout still updates */ }
  return next;
}
