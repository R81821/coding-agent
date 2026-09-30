import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme, saveTheme, watchTheme } from "./theme.js";

let dark: boolean;
let stored: string | null;
let events: EventTarget;
let dataset: Record<string, string>;
beforeEach(() => {
  dark = false;
  stored = null;
  events = new EventTarget();
  dataset = {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      get matches() { return dark; },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    }),
    localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("desktop system theme", () => {
  it("saves the system preference and resolves the current appearance again on startup", () => {
    expect(saveTheme("system")).toBe(true);
    expect(stored).toBe("system");
    expect(dataset.theme).toBe("kelo");
    dark = true;
    applyTheme(readTheme());
    expect(dataset.theme).toBe("classic");
  });
  it("follows live system changes without overwriting the saved preference", () => {
    saveTheme("system");
    const stop = watchTheme("system");
    dark = true;
    events.dispatchEvent(new Event("change"));
    expect(dataset.theme).toBe("classic");
    dark = false;
    events.dispatchEvent(new Event("change"));
    expect(dataset.theme).toBe("kelo");
    expect(stored).toBe("system");
    stop();
  });
  it("removes the listener when switching back to a manual theme", () => {
    const stop = watchTheme("system");
    stop();
    const stopManual = watchTheme("classic");
    events.dispatchEvent(new Event("change"));
    expect(dataset.theme).toBe("classic");
    stopManual();
    watchTheme("kelo")();
    dark = true;
    events.dispatchEvent(new Event("change"));
    expect(dataset.theme).toBe("kelo");
  });
  it("retains existing theme preferences and the default for invalid storage", () => {
    for (const theme of ["classic", "kelo"] as const) {
      saveTheme(theme);
      expect(readTheme()).toBe(theme);
      expect(dataset.theme).toBe(theme);
    }
    stored = "unknown";
    expect(readTheme()).toBe("classic");
  });
  it("still applies system appearance if saving the preference fails", () => {
    window.localStorage.setItem = () => { throw new Error("Unavailable storage"); };
    dark = true;
    expect(saveTheme("system")).toBe(false);
    expect(dataset.theme).toBe("classic");
  });
});
