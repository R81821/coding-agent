import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ToolContext } from "./ToolContext.js";

it("renders the full tool value beyond the former preview limit", () => {
  const html = renderToStaticMarkup(
    <ToolContext value={{ stdout: "x".repeat(20_100) }} />,
  );
  expect(html).toContain("x".repeat(20_100));
  expect(html).not.toContain("预览已截断");
  expect(html).not.toContain("查看完整内容");
});

it("does not add a full-content action for short values", () => {
  const html = renderToStaticMarkup(<ToolContext value={{ stdout: "done" }} />);
  expect(html).toContain("done");
  expect(html).not.toContain("查看完整内容");
});
