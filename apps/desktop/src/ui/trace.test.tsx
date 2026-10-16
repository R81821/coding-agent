import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "./trace.js";

it("does not render expensive detail components for a closed trace row", () => {
  let detailRenders = 0;
  function ExpensiveDetail() {
    detailRenders += 1;
    return <pre>private-tool-output</pre>;
  }
  const html = renderToStaticMarkup(<Trace>
    <TraceCollapsible>
      <TraceCollapsibleTrigger><TraceLine><TraceTitle>已执行测试</TraceTitle></TraceLine></TraceCollapsibleTrigger>
      <TraceCollapsibleContent><ExpensiveDetail /></TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>);
  expect(detailRenders).toBe(0);
  expect(html).not.toContain("private-tool-output");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('<button');
});

it("connects an expanded row's native button to its detail panel", () => {
  const html = renderToStaticMarkup(<TraceCollapsible defaultOpen>
    <TraceCollapsibleTrigger><TraceLine status="error"><TraceIcon><svg /></TraceIcon><TraceTitle>执行失败</TraceTitle></TraceLine></TraceCollapsibleTrigger>
    <TraceCollapsibleContent>command output</TraceCollapsibleContent>
  </TraceCollapsible>);
  const controlledId = html.match(/aria-controls="([^"]+)"/)?.[1];
  expect(controlledId).toBeTruthy();
  expect(html).toContain(`id="${controlledId}"`);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('data-status="error"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("command output");
});

it("keeps disabled trace triggers as disabled native buttons", () => {
  const html = renderToStaticMarkup(<TraceCollapsible disabled>
    <TraceCollapsibleTrigger><TraceLine><TraceTitle>不可用的记录</TraceTitle></TraceLine></TraceCollapsibleTrigger>
    <TraceCollapsibleContent>detail</TraceCollapsibleContent>
  </TraceCollapsible>);
  expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled=""');
  expect(html).not.toContain('role="button"');
});
