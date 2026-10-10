import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserPanel } from "./BrowserPanel.js";

describe("browser screenshot control", () => {
  it("offers a capture button with visible-area scope and disables it until a page is available", () => {
    const html = renderToStaticMarkup(<BrowserPanel sessionId="session-a" open onOpenChange={() => {}} />);
    expect(html).toContain('aria-label="截图当前网页"');
    expect(html).toContain('title="截图当前网页可见区域"');
    expect(html).toMatch(/<button[^>]*aria-label="截图当前网页"[^>]*disabled=""/);
    expect(html).not.toContain("browser-screenshot-dialog");
  });

  it("keeps the browser capture unavailable without a conversation and does not render a closed panel", () => {
    const html = renderToStaticMarkup(<BrowserPanel sessionId={undefined} open onOpenChange={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-label="截图当前网页"[^>]*disabled=""/);
    expect(renderToStaticMarkup(<BrowserPanel sessionId="session-a" open={false} onOpenChange={() => {}} />)).toBe("");
  });
});
