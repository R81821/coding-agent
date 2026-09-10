import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { summarizeCacheUsage } from "@harness/protocol";
import { PromptCacheStats } from "./PromptCacheStats.js";
it("weights cache hit rate by input tokens and reports missing coverage", () => {
  const usages = [{ inputTokens: 100, cachedInputTokens: 100, outputTokens: 1, estimatedUsd: 0 }, { inputTokens: 900, cachedInputTokens: 0, outputTokens: 1, estimatedUsd: 0 }, { inputTokens: 100, outputTokens: 1, estimatedUsd: 0 }];
  expect(summarizeCacheUsage(usages)).toMatchObject({ hitRate: 0.1, inputTokens: 1100, measuredInputTokens: 1000, cachedInputTokens: 100, measuredCalls: 2, totalCalls: 3 });
  const html = renderToStaticMarkup(<PromptCacheStats usages={usages} />);
  expect(html).toContain("10.0%"); expect(html).toContain("2/3"); expect(html).toContain("900");
});
it("distinguishes unreported cache usage from a measured zero", () => {
  const usage = { inputTokens: 100, outputTokens: 1, estimatedUsd: 0 };
  expect(renderToStaticMarkup(<PromptCacheStats usages={[usage]} />)).toContain("未返回缓存数据");
  expect(renderToStaticMarkup(<PromptCacheStats usages={[{ ...usage, cachedInputTokens: 0 }]} />)).toContain("0.0%");
});
