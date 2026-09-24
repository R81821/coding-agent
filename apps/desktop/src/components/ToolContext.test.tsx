import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ToolContext } from "./ToolContext.js";

it("offers the full tool value when its initial preview is truncated", () => {
  const html = renderToStaticMarkup(
    <ToolContext value={{ stdout: "x".repeat(20_100) }} />,
  );
  expect(html).toContain("预览已截断");
  expect(html).toContain("查看完整内容");
});

it("does not add a full-content action for short values", () => {
  const html = renderToStaticMarkup(<ToolContext value={{ stdout: "done" }} />);
  expect(html).toContain("done");
  expect(html).not.toContain("查看完整内容");
});
