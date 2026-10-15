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
it("places model and reasoning selection immediately before the current task mode", () => {
 const html = renderToStaticMarkup(<BuiPromptBar value="" onChange={() => {}} onSubmit={() => {}} placeholder="" disabled={false} busy={false} taskMode="auto" onTaskModeChange={() => {}} modelPicker={<button type="button" data-model-picker>GPT-6.1 Sol Ultra</button>} />);
 expect(html).toContain('data-model-picker="true"');
 expect(html.indexOf('data-model-picker="true"')).toBeLessThan(html.indexOf('class="prompt-current-mode mode-auto"'));
 expect(html.indexOf('class="prompt-current-mode mode-auto"')).toBeLessThan(html.indexOf('class="prompt-send"'));
});

it("keeps the paused composer focused on continuing without a withdrawal entry", () => {
 const props = { value: "", onChange: () => {}, onSubmit: () => {}, placeholder: "", disabled: false, busy: false, onRelease: () => {} };
 const html = renderToStaticMarkup(<BuiPromptBar {...props} holding />);
 expect(html).toContain('aria-label="继续"');
 expect(html).not.toContain("撤回");
 expect(html).not.toContain("prompt-withdraw");
 expect(renderToStaticMarkup(<BuiPromptBar {...props} holding={false} />)).not.toContain('aria-label="撤回最新一轮"');
});

it("blocks input, sending and continuing while withdrawal from the conversation is pending", () => {
 for (const value of ["", "补充说明"]) {
  const html = renderToStaticMarkup(<BuiPromptBar value={value} onChange={() => {}} onSubmit={() => {}} placeholder="" disabled={false} busy={false} holding onRelease={() => {}} withdrawing />);
  expect(html.match(/<button[^>]+aria-label="(?:继续|发送)"[^>]*>/)?.[0]).toContain('disabled=""');
  expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('disabled=""');
  expect(html).not.toContain("撤回");
 }
});
