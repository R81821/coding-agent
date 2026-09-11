import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BuiPromptBar } from "./prompt-bar.js";
it("offers explicit task modes and disables mode changes while running", () => {
 const html = renderToStaticMarkup(<BuiPromptBar value="检查" onChange={() => {}} onSubmit={() => {}} placeholder="" disabled={true} busy={true} taskMode="analysis" onTaskModeChange={() => {}} />);
 expect(html).toContain('aria-label="任务模式"'); expect(html).toContain('value="analysis" selected=""');
 expect(html).toContain('value="auto"'); expect(html).toContain('value="change"');
 expect(html.match(/<select[^>]+>/)?.[0]).toContain('disabled=""');
});
