import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible.js";
import { Marker, MarkerContent, MarkerIcon } from "./marker.js";

it("keeps a composed file marker as a native collapsible button with lazy details", () => {
  let detailRenders = 0;
  function ReadDetails() {
    detailRenders += 1;
    return <pre>file contents</pre>;
  }
  const html = renderToStaticMarkup(<Collapsible>
    <Marker render={<CollapsibleTrigger />} className="conversation-read-marker">
      <MarkerIcon><svg /></MarkerIcon>
      <MarkerContent>已读取 3 个文件</MarkerContent>
    </Marker>
    <CollapsibleContent><ReadDetails /></CollapsibleContent>
  </Collapsible>);

  expect(html).toContain("<button");
  expect(html).toContain('data-slot="marker"');
  expect(html).toContain('data-slot="marker-content"');
  expect(html).toContain('data-variant="default"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain('role="button"');
  expect(html).not.toContain("file contents");
  expect(detailRenders).toBe(0);
});

it("keeps the expanded marker's accessible link to its panel and caller props", () => {
  const html = renderToStaticMarkup(<Collapsible defaultOpen>
    <Marker variant="border" render={<CollapsibleTrigger />} aria-label="读取文件详情" className="custom-marker">
      <MarkerContent>已读取 2 个文件</MarkerContent>
    </Marker>
    <CollapsibleContent>package.json, pnpm-lock.yaml</CollapsibleContent>
  </Collapsible>);
  const controlledId = html.match(/aria-controls="([^"]+)"/)?.[1];

  expect(controlledId).toBeTruthy();
  expect(html).toContain(`id="${controlledId}"`);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-label="读取文件详情"');
  expect(html).toContain("ui-marker-variant-border custom-marker");
  expect(html).toContain('data-variant="border"');
  expect(html).toContain("package.json, pnpm-lock.yaml");
});

it("preserves disabled native trigger behavior through marker composition", () => {
  const html = renderToStaticMarkup(<Collapsible disabled>
    <Marker render={<CollapsibleTrigger />}><MarkerContent>已读取 2 个文件</MarkerContent></Marker>
  </Collapsible>);

  expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled=""');
  expect(html).not.toContain('role="button"');
});
