import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_DEFAULT, clampSidebarWidth, readSidebarWidth, saveSidebarWidth } from "./layout-preferences.js";

describe("sidebar width preferences", () => {
  it("clamps invalid and out-of-range widths", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(10)).toBe(180);
    expect(clampSidebarWidth(700)).toBe(420);
    expect(clampSidebarWidth(256.6)).toBe(257);
  });
  it("reads, saves, and survives unavailable storage", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT);
    expect(saveSidebarWidth(333)).toBe(333);
    expect(readSidebarWidth()).toBe(333);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT);
    expect(saveSidebarWidth(250)).toBe(250);
    vi.unstubAllGlobals();
  });
});
