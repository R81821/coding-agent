import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./markdown-message.js";
import { messageHttpUrl } from "./message-links.js";
const render = (text: string) => renderToStaticMarkup(<MarkdownMessage text={text} />);

describe("Markdown message rendering", () => {
  it("renders headings, emphasis, lists, quotes, task lists and GFM tables", () => {
    const html = render("# 标题\n\n**重点**与 `code`\n\n- 项目\n\n1. 步骤\n\n> 引用\n\n- [x] 已完成\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n");
    for (const part of ["<h1>", "<strong>", "<ul>", "<ol>", "<blockquote>", "<table>", "<thead>", 'type="checkbox"', 'checked=""', "md-table-scroll"]) expect(html).toContain(part);
    expect(html).not.toContain("# 标题");
  });
  it("highlights fenced code and gives inline code no copy toolbar", () => {
    const html = render("`inline`\n\n```js\nconst answer = 42;\n```\n");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("复制代码");
    expect(html).toContain("<code>inline</code>");
    expect(html.match(/class="md-code-block"/g)).toHaveLength(1);
  });
  it("tolerates partial streamed fences, tables and unknown languages", () => {
    for (const partial of ["# 标", "**未结束", "```js\nconst x =", "| A | B |\n| --", "```unknown-lang\n<hello>"]) expect(() => render(partial)).not.toThrow();
    const html = render("```unknown-lang\n<hello>");
    expect(html).toContain("&lt;hello&gt;");
  });
  it("keeps raw HTML and unsafe links inert and never loads images automatically", () => {
    const html = render('<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n[文件](file:///C:/secret)\n\n![图片](https://example.com/tracker.png)\n\n```html\n<script>alert(2)</script>\n```');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/tracker.png"');
  });
  it("offers raw Markdown controls for replies and compact rendering for progress", () => {
    expect(render("## reply")).toContain("查看原文");
    expect(render("## reply")).toContain("复制 Markdown");
    const html = renderToStaticMarkup(<MarkdownMessage text="## 过程" compact />);
    expect(html).toContain("<h2>");
    expect(html).not.toContain("md-message-actions");
  });
  it("only accepts credential-free HTTP(S) links at the desktop boundary", () => {
    expect(messageHttpUrl("https://example.com/docs?q=ok")).toBe("https://example.com/docs?q=ok");
    for (const url of ["javascript:alert(1)", "file:///C:/secret", "data:text/html,hi", "https://user:pass@example.com", "//example.com", {}, "https://"]) expect(messageHttpUrl(url)).toBeUndefined();
  });
});