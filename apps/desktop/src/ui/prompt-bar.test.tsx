import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BuiPromptBar } from "./prompt-bar.js";
it("shows only the color-coded current mode and an accessible additions button", () => {
 const html = renderToStaticMarkup(<BuiPromptBar value="检查" onChange={() => {}} onSubmit={() => {}} placeholder="" disabled={true} busy={true} taskMode="analysis" onTaskModeChange={() => {}} />);
 expect(html).toContain('aria-label="添加内容"');
 expect(html).toContain('class="prompt-current-mode mode-analysis"');
 expect(html).toContain('>Plan</span>');
 expect(html).not.toContain('Shift+Tab');
 expect(html).not.toContain('自动路由');
 expect(html).not.toContain('<select');
 expect(html.match(/<button[^>]+aria-label="添加内容"[^>]*>/)?.[0]).toContain('disabled=""');
});
