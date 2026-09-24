import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { InlineReview, selectInlineReviewFiles } from "./InlineReview.js";

it("uses captured run changes", () => {
  const files = selectInlineReviewFiles({
    runId: "run",
    status: "ready",
    files: [
      {
        path: "src/a.ts",
        added: 2,
        deleted: 1,
        diff: "",
        canUndo: true,
        undone: false,
      },
    ],
  });
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: "src/a.ts", added: 2, canUndo: true });
});

it("hides the review unless a ready capture has actual changed files", () => {
  expect(
    selectInlineReviewFiles({ runId: "run", status: "ready", files: [] }),
  ).toEqual([]);
  expect(
    selectInlineReviewFiles({ runId: "run", status: "capturing", files: [] }),
  ).toEqual([]);
  expect(
    selectInlineReviewFiles({ runId: "run", status: "unavailable", files: [] }),
  ).toEqual([]);
  const html = renderToStaticMarkup(
    <InlineReview runId="old" review={undefined} onUndo={async () => {}} />,
  );
  expect(html).toBe("");
});

it("offers per-file undo for a captured change", () => {
  const html = renderToStaticMarkup(
    <InlineReview
      runId="run"
      review={{
        runId: "run",
        status: "ready",
        files: [
          {
            path: "src/a.ts",
            added: 2,
            deleted: 1,
            diff: "",
            canUndo: true,
            undone: false,
          },
        ],
      }}
      onUndo={async () => {}}
    />,
  );
  expect(html).toContain("撤销");
  expect(html).toContain("+2");
  expect(html).toContain("−1");
  expect(html).toContain("忽略文件不在审核范围内");
});
