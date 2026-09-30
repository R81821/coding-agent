import { useEffect, useState } from "react";
import type { ThemeId } from "./theme.js";
import {
  appearanceMode,
  applyAppearance,
  normalizeAppearance,
  readAppearance,
  saveAppearance,
  type AppearancePreferences,
} from "./appearance.js";

export function useAppearance(theme: ThemeId) {
  const [preferences, setPreferences] = useState(readAppearance);
  const [saved, setSaved] = useState(true);
  const [mode, setMode] = useState(() =>
    appearanceMode(
      theme,
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    ),
  );
  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      const next = appearanceMode(theme, dark.matches);
      setMode(next);
      applyAppearance(preferences, next, motion.matches);
    };
    sync();
    dark.addEventListener("change", sync);
    motion.addEventListener("change", sync);
    return () => {
      dark.removeEventListener("change", sync);
      motion.removeEventListener("change", sync);
    };
  }, [theme, preferences]);
  function update(next: AppearancePreferences) {
    const normalized = normalizeAppearance(next);
    setPreferences(normalized);
    setSaved(saveAppearance(normalized));
  }
  return { preferences, update, saved, mode };
}
export type AppearanceController = ReturnType<typeof useAppearance>;
