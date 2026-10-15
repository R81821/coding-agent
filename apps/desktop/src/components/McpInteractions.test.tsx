import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { McpInteractionCard, type McpInteractionView } from "./McpInteractions.js";
import { elicitationContent, elicitationDateTimeInput, elicitationDefaults, elicitationFields } from "./mcp-elicitation.js";
import { mcpContentText, mcpPromptDraft, mcpResourceDraft, mcpTemplateUri, mcpTemplateVariables } from "./mcp-content.js";

const interaction: McpInteractionView = { id: "request", serverId: "server", serverName: "Research", workspacePath: "C:/project", createdAt: "2026-10-13T00:00:00Z", kind: "sampling", modelName: "Configured model", params: { systemPrompt: "Use the request as supplied", maxTokens: 100, messages: [{ role: "user", content: { type: "text", text: "Summarize <script>source</script>" } }] } };
const request = async <T,>(): Promise<T> => ({}) as T;
test("sampling presents model, exact server message and approval instead of executing", () => {
  const html = renderToStaticMarkup(<McpInteractionCard interaction={interaction} request={request} onResponded={() => {}} />);
  expect(html).toContain("Configured model"); expect(html).toContain("批准采样"); expect(html).toContain("最多输出 100 tokens"); expect(html).toContain("Summarize &lt;script&gt;source&lt;/script&gt;"); expect(html).not.toContain("<script>");
  expect(html).toContain("仅使用服务提供的消息，不包含其他会话历史");
});
test("elicitation form renders required primitives, enum labels and multiselect", () => {
  const params = { message: "Provide preferences", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 5 }, email: { type: "string", format: "email" }, agreed: { type: "boolean" }, style: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] }, tags: { type: "array", items: { enum: ["x", "y"], type: "string" } } }, required: ["count", "agreed"] } };
  const html = renderToStaticMarkup(<McpInteractionCard interaction={{ ...interaction, kind: "elicitation", params }} request={request} onResponded={() => {}} />);
  expect(html).toContain("count *"); expect(html).toContain("Alpha"); expect(html).toContain("type=\"email\""); expect(html).toContain("type=\"checkbox\""); expect(html).toContain("提交信息"); expect(html).toContain("Provide preferences");
});
test("URL elicitation needs explicit user confirmation and keeps external content escaped", () => {
  const html = renderToStaticMarkup(<McpInteractionCard interaction={{ ...interaction, kind: "elicitation", params: { mode: "url", message: "Authorize account", url: "https://example.test/auth?a=1&b=2" } }} request={request} onResponded={() => {}} />);
  expect(html).toContain("打开服务网页"); expect(html).toContain("我已在网页完成操作"); expect(html).toMatch(/disabled=""[^>]*>确认完成/);
  const bad = renderToStaticMarkup(<McpInteractionCard interaction={{ ...interaction, kind: "elicitation", params: { mode: "url", url: "javascript:alert(1)" } }} request={request} onResponded={() => {}} />);
  expect(bad).toMatch(/disabled=""[^>]*><svg[^]*?打开服务网页/);
});
test("unsupported schema disables submission instead of inventing data", () => {
  const html = renderToStaticMarkup(<McpInteractionCard interaction={{ ...interaction, kind: "elicitation", params: { requestedSchema: { type: "object", properties: { nested: { type: "object" } } } } }} request={request} onResponded={() => {}} />);
  expect(html).toContain("表单类型暂不支持"); expect(html).toMatch(/disabled=""[^>]*>提交信息/);
});
test("form content preserves false and typed numbers, excludes unknown and empty optional values", () => {
  const fields = elicitationFields({ type: "object", required: ["ok", "count"], properties: { ok: { type: "boolean" }, count: { type: "integer", minimum: 0 }, note: { type: "string" }, tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 2 } } })!;
  expect(elicitationContent(fields, { ok: false, count: "0", note: "", unknown: "secret", tags: ["x"] })).toEqual({ ok: false, count: 0, tags: ["x"] });
  expect(() => elicitationContent(fields, { ok: false, count: "1.5" })).toThrow(/整数/);
  expect(() => elicitationContent(fields, { count: "1" })).toThrow(/ok/);
  expect(() => elicitationContent(fields, { ok: true, count: "1", tags: ["unrecognized"] })).toThrow(/无效选项/);
});
test("default and schema option parsing preserves enum values separately from labels", () => {
  const fields = elicitationFields({ type: "object", properties: { preference: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"], default: "b" }, tags: { type: "array", items: { anyOf: [{ const: "one", title: "One" }, { const: "two", title: "Two" }] }, default: ["one"] } } })!;
  expect(fields[0]?.enumNames).toEqual(["Alpha", "Beta"]); expect(fields[1]?.enum).toEqual(["one", "two"]); expect(elicitationDefaults(fields)).toEqual({ preference: "b", tags: ["one"] });
});
test("date-time controls display local input and submit a timestamp with explicit timezone", () => {
  const fields = elicitationFields({ type: "object", required: ["time"], properties: { time: { type: "string", format: "date-time" } } })!;
  expect(elicitationDateTimeInput("2026-10-13T12:30")).toBe("2026-10-13T12:30");
  expect(elicitationDateTimeInput("2026-10-13T04:30:00Z")).toMatch(/^2026-10-13T\d\d:30:00\.000$/);
  expect(elicitationContent(fields, { time: "2026-10-13T12:30" }).time).toBe(new Date("2026-10-13T12:30").toISOString());
  expect(() => elicitationContent(fields, { time: "invalid" })).toThrow(/日期和时间/);
});
test("applying external prompts keeps roles as plain draft text and does not expose binary data", () => {
  expect(mcpPromptDraft({ messages: [{ role: "user", content: { type: "text", text: "Do the work" } }, { role: "assistant", content: { type: "image", mimeType: "image/png", data: "secret-base64" } }] }, "Research", "plan")).toBe("来自 MCP 提示词：Research / plan\n\n[用户]\nDo the work\n\n[助手]\n[图片 · image/png]");
  expect(mcpResourceDraft({ contents: [{ uri: "resource://doc", text: "Text" }, { uri: "resource://secret", blob: "secret-base64" }] }, "Research")).toBe("来自 MCP 资源：Research\nURI：resource://doc\n\nText");
  expect(mcpContentText({ type: "resource", resource: { uri: "resource://document", text: "Embedded text" } })).toBe("Embedded text");
});
test("resource template completion expands scalar URI operators without changing reserved characters", () => {
  const template = "fixture://docs/{id}{?query,locale}{#section}";
  expect(mcpTemplateVariables(template)).toEqual(["id", "query", "locale", "section"]);
  expect(mcpTemplateUri(template, { id: "a/b", query: "a b", locale: "中文", section: "part/2" })).toBe("fixture://docs/a%2Fb?query=a%20b&locale=%E4%B8%AD%E6%96%87#part/2");
  expect(mcpTemplateUri("fixture://docs/{id}", {})).toBe("fixture://docs/{id}");
  expect(mcpTemplateUri("fixture:{+path}{/topic:2}", { path: "/a?b=1", topic: "文字列" })).toBe("fixture:/a?b=1/%E6%96%87%E5%AD%97");
});
