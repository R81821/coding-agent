import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { summarizeCacheUsage } from "@harness/protocol";
import { PromptCacheStats } from "./PromptCacheStats.js";
import type { AgentEvent } from "@harness/protocol";
it("labels main and total rates separately and counts recorded summary outcomes", () => {
  const events = [
    { type: "context_compacted", record: { summaryOutcome: "accepted" } },
    { type: "context_compacted", record: { summaryOutcome: "truncated" } },
    { type: "context_compacted", record: { summaryOutcome: "disabled_after_failure" } },
    { type: "context_adjusted", adjustment: { kind: "tool_prune" } },
    { type: "context_adjusted", adjustment: { kind: "policy_migration" } }
  ] as AgentEvent[];
  const usages = [{ purpose: "main" as const, inputTokens: 100, cachedInputTokens: 100, outputTokens: 1, estimatedUsd: 0 }, { purpose: "compaction" as const, inputTokens: 100, cachedInputTokens: 0, outputTokens: 1, estimatedUsd: 0 }];
  const html = renderToStaticMarkup(<PromptCacheStats usages={usages} events={events} />);
  for (const value of ["主调用命中率 100.0%", "总输入缓存命中率 50.0%", "摘要采用 1/2（50.0%）", "历史裁剪 1", "已迁移"]) expect(html).toContain(value);
  expect(renderToStaticMarkup(<PromptCacheStats usages={usages} events={[]} />)).toContain("摘要采用率不适用");
});
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

it("separates request purposes and distinguishes known zero from unknown prices", () => {
  const usages = [{ purpose: "main" as const, inputTokens: 10, outputTokens: 1, cachedInputTokens: 10, estimatedUsd: 0, costKnown: true }, { purpose: "compaction" as const, inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, estimatedUsd: 0, costKnown: false }, { purpose: "review" as const, inputTokens: 30, outputTokens: 3, estimatedUsd: 0, costKnown: false }];
  const html = renderToStaticMarkup(<PromptCacheStats usages={usages} />);
  for (const value of ["主调用", "上下文压缩", "独立评审", "费用未知", "$0.0000"]) expect(html).toContain(value);
  expect(html).toContain("1/1");
});
