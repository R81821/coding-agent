import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BuiToolChip } from "./tool-chip.js";

it("renders tool names without a boxed chip", () => {
  const html = renderToStaticMarkup(<BuiToolChip name="terminal" status="finished" />);
  expect(html).toContain("terminal");
  expect(html).not.toContain("border");
  expect(html).not.toContain("bg-");
});
