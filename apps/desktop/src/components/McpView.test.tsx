import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { McpView } from "./McpView.js";
import { buildMcpDraft, mcpForm, secretPatch } from "./mcp-form.js";
import { McpServerConfigSchema } from "@harness/protocol";

test("secret edits preserve old values unless replace or clear was selected", () => {
  expect(secretPatch([{ key: "KEEP", mode: "keep", value: "" }, { key: "REPLACE", mode: "replace", value: "new" }, { key: "CLEAR", mode: "clear", value: "" }])).toEqual({ REPLACE: "new", CLEAR: null });
  expect(() => secretPatch([{ key: "a", mode: "replace", value: "1" }, { key: "a", mode: "replace", value: "2" }])).toThrow(/重复/);
});
test("editing public configuration keeps the revision and uses distinct command arguments", () => {
  const config = McpServerConfigSchema.parse({ id: "server", name: "Local", revision: 3, transport: { type: "stdio", command: "node", args: ["C:/A path/server.mjs", "--flag"] }, projectPaths: ["C:/project"] });
  const { env, headers, ...publicFields } = config;
  const form = mcpForm({ ...publicFields, envKeys: ["TOKEN"], headerKeys: [] }, "C:/project");
  const draft = buildMcpDraft(form);
  expect(draft).toMatchObject({ id: "server", expectedRevision: 3, transport: config.transport, env: {} });
  expect(() => buildMcpDraft({ ...form, args: "--not-json" })).toThrow(/JSON/);
});
test("management cards show project binding, connection and authentication states without stored values", () => {
  const config = McpServerConfigSchema.parse({ id: "server", name: "Research", revision: 1, enabled: true, transport: { type: "streamable_http", url: "https://mcp.example.test/mcp" }, projectPaths: ["C:/project"] });
  const { env, headers, ...publicFields } = config;
  const html = renderToStaticMarkup(<McpView workspacePath="C:/project" initialSnapshot={{ servers: [{ ...publicFields, envKeys: [], headerKeys: ["Authorization"] }], statuses: [{ serverId: "server", revision: 1, workspacePath: "C:/project", state: "connected", toolCount: 4 }], auth: { server: { state: "authorized" } } }} />);
  expect(html).toContain("Research"); expect(html).toContain("已连接"); expect(html).toContain("4 个工具"); expect(html).toContain("已登录"); expect(html).toContain("编辑"); expect(html).toContain("工具目录");
});
test("no-project view tells users to select a project before connecting", () => {
  const html = renderToStaticMarkup(<McpView workspacePath="" />);
  expect(html).toContain("选择项目后"); expect(html).toContain("新增服务");
});
