import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./markdown-message.js";
import { messageHttpUrl } from "./message-links.js";
const render = (text: string, props: { compact?: boolean; isStreaming?: boolean } = {}) => renderToStaticMarkup(<MarkdownMessage text={text} {...props} />);

describe("Markdown message rendering", () => {
  it("renders headings, emphasis, lists, quotes, task lists and GFM tables", () => {
    const html = render("# 标题\n\n**重点**与 `code`\n\n- 项目\n\n1. 步骤\n\n> 引用\n\n- [x] 已完成\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n");
    for (const part of ["<h1", "<strong>", "<ul", "<ol", "<blockquote", "<table", "<thead", 'type="checkbox"', 'checked=""', "md-table-scroll"]) expect(html).toContain(part);
    expect(html).not.toContain("# 标题");
  });
  it("renders a fenced code toolbar without adding one to inline code", () => {
    const html = render("`inline`\n\n```js\nconst answer = 42;\n```\n");
    expect(html).toContain("复制代码");
    expect(html).toMatch(/<code(?:\s[^>]*)?>inline<\/code>/);
    expect(html).toContain("const answer = 42;");
    expect(html.match(/class="md-code-block(?:\s[^"]*)?"/g)).toHaveLength(1);
    // Shiki loads languages asynchronously in the browser. Its eventual token
    // colors are checked by markdown-ui-test.cjs rather than an SSR class name.
  });
  it("repairs incomplete emphasis only while a response is streaming", () => {
    const partial = "**正在生成";
    expect(render(partial, { isStreaming: true })).toContain("<strong>正在生成</strong>");
    expect(render(partial)).toContain("**正在生成");
    expect(render(partial)).not.toContain("<strong>");
    expect(render("**最终答案**")).toContain("<strong>最终答案</strong>");
  });
  it("preserves indented code and literal Markdown in completed replies", () => {
    const html = render("    const literal = '**literal**';\n");
    expect(html).toContain("md-code-block");
    expect(html).toContain("**literal**");
    expect(html).not.toContain("<strong>");
  });
  it("keeps a partial streamed link inert until its destination is complete", () => {
    const html = render("请看 [参考文档](https://example.com/doc", { isStreaming: true });
    expect(html).toContain("参考文档");
    expect(html).not.toContain('href="https://example.com/doc"');
    expect(render("请看 [参考文档](https://example.com/docs)", { isStreaming: true })).toContain('href="https://example.com/docs"');
  });
  it.each([true, false])("resolves reference links across paragraphs (streaming: %s)", (isStreaming) => {
    const html = render("请看 [参考文档][docs]。\n\n中间还有另一段正文。\n\n[docs]: https://example.com/docs\n", { isStreaming });
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain("[参考文档][docs]");
    expect(html).not.toContain("[docs]:");
  });
  it.each([true, false])("keeps footnotes and their return links connected across paragraphs (streaming: %s)", (isStreaming) => {
    const html = render("有来源的结论[^note]。\n\n中间还有另一段正文。\n\n[^note]: 脚注说明。\n", { isStreaming });
    expect(html).toContain("脚注说明");
    const footnoteTarget = /href="#([^"]*fn-note)"/.exec(html)?.[1];
    const returnTarget = /href="#([^"]*fnref-note)"/.exec(html)?.[1];
    expect(footnoteTarget).toBeDefined();
    expect(returnTarget).toBeDefined();
    expect(html).toContain(`id="${footnoteTarget}"`);
    expect(html).toContain(`id="${returnTarget}"`);
  });
  it("tolerates partial streamed fences, tables and unknown languages without losing code", () => {
    for (const partial of ["# 标", "**未结束", "```js\nconst x =", "| A | B |\n| --", "```unknown-lang\n<hello>"]) expect(() => render(partial, { isStreaming: true })).not.toThrow();
    const partialCode = render("```js\nconst x =", { isStreaming: true });
    expect(partialCode).toContain("const x =");
    expect(partialCode).toContain("复制代码");
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
    expect(html).toContain("图片：图片");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });
  it("rejects unsafe autolinks and image destinations as well as regular links", () => {
    const html = render("[凭据](https://user:pass@example.com)\n\n[协议相对](//example.com)\n\n![本地图片](file:///C:/secret.png)\n\n![内嵌图片](data:image/png;base64,AAAA)");
    for (const forbidden of ['href="https://user:pass', 'href="//example.com', "file://", "data:image", "<img"]) expect(html).not.toContain(forbidden);
    expect(html).toContain("凭据");
    expect(html).toContain("本地图片");
  });
  it("offers raw Markdown controls for replies and compact rendering for progress", () => {
    expect(render("## reply")).toContain("查看原文");
    expect(render("## reply")).toContain("复制 Markdown");
    const html = render("## 过程", { compact: true, isStreaming: true });
    expect(html).toContain("<h2");
    expect(html).toContain("md-compact");
    expect(html).not.toContain("md-message-actions");
    expect(html).not.toContain("查看原文");
    expect(html).not.toContain("复制 Markdown");
  });
  it("only accepts credential-free HTTP(S) links at the desktop boundary", () => {
    expect(messageHttpUrl("https://example.com/docs?q=ok")).toBe("https://example.com/docs?q=ok");
    for (const url of ["javascript:alert(1)", "file:///C:/secret", "data:text/html,hi", "https://user:pass@example.com", "//example.com", {}, "https://"]) expect(messageHttpUrl(url)).toBeUndefined();
  });
});
