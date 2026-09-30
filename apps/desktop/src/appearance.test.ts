import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  activeVisualStyle,
  appearanceMode,
  applyAppearance,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  readAppearance,
  saveAppearance,
  setSeparateModes,
  visualColors,
} from "./appearance.js";

let stored: string | null;
let dataset: Record<string, string>;
let variables: Map<string, string>;
beforeEach(() => {
  stored = null;
  dataset = {};
  variables = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      style: {
        setProperty: (key: string, value: string) => variables.set(key, value),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("loads safe defaults for corrupt settings and clamps typography ranges", () => {
  stored = "{";
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  const prefs = normalizeAppearance({
    uiSize: 99,
    codeSize: -10,
    contrast: Infinity,
    shared: { accent: "url(https://example.com)", background: "#123456" },
  });
  expect(prefs.uiSize).toBe(22);
  expect(prefs.codeSize).toBe(10);
  expect(prefs.contrast).toBe(60);
  expect(prefs.shared.accent).toBe("");
  expect(prefs.shared.background).toBe("#123456");
});
it("retains separate light and dark styles across restart and system changes", () => {
  let prefs = setSeparateModes(normalizeAppearance(null), true, "dark");
  prefs = {
    ...prefs,
    dark: { ...prefs.dark, background: "#123456", font: "serif" },
    light: { ...prefs.light, background: "#abcdef", font: "sans" },
  };
  expect(saveAppearance(prefs)).toBe(true);
  const loaded = readAppearance();
  applyAppearance(loaded, appearanceMode("system", true), false);
  expect(variables.get("--appearance-bg")).toBe("#123456");
  expect(variables.get("--ui-font")).toContain("Georgia");
  applyAppearance(loaded, appearanceMode("system", false), false);
  expect(variables.get("--appearance-bg")).toBe("#abcdef");
  expect(variables.get("--ui-font")).toContain("Arial");
  expect(readAppearance()).toEqual(loaded);
});
it("initializes separate styles independently and preserves the active style when merged", () => {
  const split = setSeparateModes(
    normalizeAppearance({ shared: { accent: "#123456" } }),
    true,
    "dark",
  );
  expect(split.light.accent).toBe("#123456");
  expect(split.dark.accent).toBe("#123456");
  split.dark.accent = "#abcdef";
  expect(split.light.accent).toBe("#123456");
  expect(
    activeVisualStyle(setSeparateModes(split, false, "dark"), "light").accent,
  ).toBe("#abcdef");
});
it("applies independent typography and explicit motion overrides", () => {
  const prefs = normalizeAppearance({
    uiSize: 18,
    codeSize: 15,
    contentFont: "serif",
    codeWeight: "bold",
    reducedMotion: "off",
    diffMarkers: "symbols",
    pointerCursor: true,
    translucentSidebar: false,
  });
  applyAppearance(prefs, "dark", true);
  expect(variables.get("--ui-font-size")).toBe("18px");
  expect(variables.get("--code-font-size")).toBe("15px");
  expect(variables.get("--content-font")).toContain("Georgia");
  expect(variables.get("--code-font-weight")).toBe("700");
  expect(dataset.reducedMotion).toBe("false");
  expect(dataset.diffMarkers).toBe("symbols");
  expect(dataset.pointerCursor).toBe("true");
  expect(dataset.translucentSidebar).toBe("false");
  applyAppearance({ ...prefs, reducedMotion: "on" }, "light", false);
  expect(dataset.reducedMotion).toBe("true");
  applyAppearance({ ...prefs, reducedMotion: "system" }, "light", false);
  expect(dataset.reducedMotion).toBe("false");
  applyAppearance({ ...prefs, reducedMotion: "system" }, "light", true);
  expect(dataset.reducedMotion).toBe("true");
});
it("chooses readable text for white accent controls and mode-specific preset colors", () => {
  const prefs = normalizeAppearance({
    shared: { accent: "#ffffff", preset: "ocean" },
  });
  applyAppearance(prefs, "dark", false);
  expect(variables.get("--appearance-on-accent")).toBe("#161616");
  expect(dataset.appearanceTone).toBe("dark");
  applyAppearance(
    { ...prefs, shared: { ...prefs.shared, background: "#121212" } },
    "light",
    false,
  );
  expect(variables.get("color-scheme")).toBe("dark");
  expect(visualColors(prefs.shared, "dark").background).not.toEqual(
    visualColors(prefs.shared, "light").background,
  );
});
it("reports unavailable persistence without preventing application", () => {
  window.localStorage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  expect(saveAppearance(DEFAULT_APPEARANCE)).toBe(false);
  applyAppearance(DEFAULT_APPEARANCE, "light", false);
  expect(variables.get("--appearance-bg")).toBe("#ffffff");
});
