import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ApprovalDialog } from "./ApprovalDialog.js";

vi.mock("./DecisionDialog.js", () => ({
  DecisionDialog: ({ children, extraAction, confirmLabel, cancelLabel }: { children: React.ReactNode; extraAction?: React.ReactNode; confirmLabel: string; cancelLabel: string }) =>
    <div>{children}<footer>{extraAction}<button>{cancelLabel}</button><button>{confirmLabel}</button></footer></div>,
}));

const props = { title: "审批", description: "操作说明", status: "待审批", confirmLabel: "批准一次", onConfirm: () => {}, onCancel: () => {}, onDismiss: () => {} };

it("keeps the existing approval actions when pausing is unavailable", () => {
  const html = renderToStaticMarkup(<ApprovalDialog {...props} alternativesLabel="查看参数"><p>参数</p></ApprovalDialog>);
  expect(html).toContain("查看参数");
  expect(html).toContain("拒绝");
  expect(html).toContain("批准一次");
  expect(html).not.toContain("暂停本轮");
});

it("offers pause directly beside the approval actions without opening operation details", () => {
  for (const withDetails of [false, true]) {
    const html = renderToStaticMarkup(<ApprovalDialog {...props} onPause={() => {}} {...(withDetails ? { alternativesLabel: "查看参数", children: <p>参数</p> } : {})} />);
    const footer = html.slice(html.indexOf("<footer>"));
    expect(footer).toContain("暂停本轮");
    expect(footer).toContain("拒绝");
    expect(footer).toContain("批准一次");
    expect(footer.includes("查看参数")).toBe(withDetails);
  }
});
