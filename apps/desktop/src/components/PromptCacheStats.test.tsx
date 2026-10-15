import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PromptCacheStats } from "./PromptCacheStats.js";
import type { AgentEvent, Usage } from "@harness/protocol";

const usage: Usage = { inputTokens: 100, outputTokens: 10, estimatedUsd: 0 };
const contextEvent = (usedTokens: number, capacityTokens: number, source: "estimate" | "provider" = "estimate") => ({
  type: "context_usage", id: "context", runId: "run", at: "2026-10-11T03:00:00.000Z", sequence: 1, context: { usedTokens, capacityTokens, source }
}) as AgentEvent;
const adjustmentEvent = (adjustment: Extract<AgentEvent, { type: "context_adjusted" }>["adjustment"]) => ({ type: "context_adjusted", adjustment }) as AgentEvent;
const usageEvent = (value: Usage) => ({ type: "usage", usage: value }) as AgentEvent;
const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("shows four metrics in one row with totals across all request purposes", () => {
  const events = [
    { type: "context_compacted", record: { summaryOutcome: "accepted" } },
    { type: "context_compacted", record: { summaryOutcome: "target_fallback" } },
    { type: "context_adjusted", adjustment: { kind: "tool_prune" } },
    { type: "context_adjusted", adjustment: { kind: "policy_migration" } }
  ] as AgentEvent[];
  const usages = [
    { ...usage, purpose: "main" as const, cachedInputTokens: 100, outputTokens: 11 },
    { ...usage, purpose: "compaction" as const, inputTokens: 900, cachedInputTokens: 0, outputTokens: 22 },
    { ...usage, purpose: "review" as const, inputTokens: 200, outputTokens: 33 }
  ];
  const html = renderToStaticMarkup(<PromptCacheStats usages={usages} events={events} />);
  expect(text(html)).toContain("总输入缓存命中率 10.0%总输入 token 1,200总输出 token 66压缩次数 2");
  expect(html).toContain("flex-nowrap");
  expect(html).toContain("whitespace-nowrap");
  for (const removed of ["主调用命中率", "统计覆盖", "次请求", "已命中", "未命中", "摘要采用", "历史裁剪", "完整压缩", "首次结果限长", "前缀重写", "已迁移", "费用", "<table"]) {
    expect(html).not.toContain(removed);
  }
});

it("distinguishes unreported cache usage from a measured zero", () => {
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[usage]} />))).toContain("总输入缓存命中率 —");
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[{ ...usage, cachedInputTokens: 0 }]} />))).toContain("总输入缓存命中率 0.0%");
});

it("renders context occupancy from the latest measured context, not cumulative input", () => {
  const html = renderToStaticMarkup(<PromptCacheStats usages={[{ ...usage, inputTokens: 1_352_050 }]} events={[contextEvent(90, 100), contextEvent(490_000, 1_000_000, "provider")]} />);
  expect(html).toContain('aria-label="上下文占用"');
  expect(html).toContain('aria-valuenow="49"');
  expect(html).toContain('style="width:49%"');
  expect(text(html)).toContain("上下文49%");
  expect(html).toContain('title="490,000 / 1,000,000 tokens"');
});

it("updates occupancy immediately after a compression while retaining cumulative totals", () => {
  const events = [contextEvent(850_000, 1_000_000), { type: "context_compacted", record: { summaryOutcome: "accepted" } } as AgentEvent, contextEvent(270_000, 1_000_000)];
  const html = renderToStaticMarkup(<PromptCacheStats usages={[{ ...usage, inputTokens: 1_352_050 }]} events={events} />);
  expect(html).toContain('aria-valuenow="27"');
  expect(text(html)).toContain("总输入 token 1,352,050总输出 token 10压缩次数 1上下文27%");
  expect(html).toContain('title="估算 270,000 / 1,000,000 tokens"');
});

it("restores the screenshot's historical context from its recorded capacity and latest main request", () => {
  const usages = [
    { ...usage, inputTokens: 2_297_919, outputTokens: 207_111 },
    { ...usage, purpose: "main" as const, inputTokens: 54_098, outputTokens: 1_189 }
  ];
  const events = [
    usageEvent(usages[0]!),
    adjustmentEvent({ kind: "full_compaction", afterTokens: 56_521, capacityTokens: 128_000 }),
    ...Array.from({ length: 9 }, () => ({ type: "context_compacted", record: { summaryOutcome: "accepted" } }) as AgentEvent),
    usageEvent(usages[1]!)
  ];
  const html = renderToStaticMarkup(<PromptCacheStats usages={usages} events={events} />);
  expect(text(html)).toContain("总输入 token 2,352,017总输出 token 208,300压缩次数 9上下文43%");
  expect(html).toContain('title="55,287 / 128,000 tokens"');
  expect(html).toContain('style="width:43.19296875%"');
});

it("uses legacy post-compaction occupancy before another main request and ignores summary/review billing", () => {
  const events = [
    usageEvent({ ...usage, inputTokens: 850_000 }),
    adjustmentEvent({ kind: "full_compaction", afterTokens: 270_000, capacityTokens: 1_000_000 }),
    usageEvent({ ...usage, purpose: "compaction", inputTokens: 990_000 }),
    usageEvent({ ...usage, purpose: "review", inputTokens: 900_000 })
  ];
  const html = renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={events} />);
  expect(text(html)).toContain("上下文27%");
  expect(html).toContain('title="估算 270,000 / 1,000,000 tokens"');
});

it("updates legacy occupancy from later main requests including ones without a purpose field", () => {
  const events = [
    adjustmentEvent({ kind: "full_compaction", afterTokens: 270_000, capacityTokens: 1_000_000 }),
    usageEvent({ ...usage, inputTokens: 488_000, outputTokens: 2_000 }),
    usageEvent({ ...usage, purpose: "compaction", inputTokens: 900_000 }),
    usageEvent({ ...usage, purpose: "review", inputTokens: 990_000 }),
    adjustmentEvent({ kind: "tool_result_bound", beforeCharacters: 20_000, afterCharacters: 5_000 }),
    usageEvent({ ...usage, inputTokens: 0, outputTokens: 0 })
  ];
  const html = renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={events} />);
  expect(text(html)).toContain("上下文49%");
  expect(html).toContain('title="490,000 / 1,000,000 tokens"');
});

it("applies newer context adjustments instead of keeping stale telemetry", () => {
  const events = [contextEvent(850_000, 1_000_000, "provider"), adjustmentEvent({ kind: "full_compaction", afterTokens: 270_000 })];
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={events} />))).toContain("上下文27%");
});

it("uses a historical recorded capacity without inventing one from input totals", () => {
  const main = usageEvent({ ...usage, inputTokens: 54_000, outputTokens: 1_000 });
  const migration = adjustmentEvent({ kind: "policy_migration", capacityTokens: 1_000_000 });
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={[main, migration]} />))).toContain("上下文6%");
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={[main]} />))).toContain("上下文—");
});

it("does not carry a historical capacity across a model switch", () => {
  const route = (modelId: string) => ({ type: "route", providerId: "provider", modelId }) as AgentEvent;
  const events = [route("old"), contextEvent(490_000, 1_000_000), route("new"), usageEvent(usage)];
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={events} />))).toContain("上下文—");
});

it("shows unknown context for historical events without telemetry or a valid capacity", () => {
  for (const events of [undefined, [contextEvent(10, 0)], [contextEvent(10, NaN)], [contextEvent(Infinity, 100)], [contextEvent(-1, 100)]]) {
    const html = renderToStaticMarkup(<PromptCacheStats usages={[usage]} {...(events ? { events } : {})} />);
    expect(text(html)).toContain("上下文—");
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('aria-valuetext="上下文占用未知"');
    expect(html).toContain('style="width:0%"');
  }
});

it("clamps over-capacity fill while keeping its percentage truthful, and preserves a measured empty context", () => {
  const full = renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={[contextEvent(120, 100)]} />);
  expect(full).toContain('aria-valuenow="100"');
  expect(full).toContain('style="width:100%"');
  expect(text(full)).toContain("上下文120%");
  const empty = renderToStaticMarkup(<PromptCacheStats usages={[usage]} events={[contextEvent(0, 100)]} />);
  expect(text(empty)).toContain("上下文0%");
  expect(empty).toContain('aria-valuenow="0"');
});

it("can show live context before the first returned usage and stays hidden without data", () => {
  expect(renderToStaticMarkup(<PromptCacheStats usages={[]} />)).toBe("");
  const html = renderToStaticMarkup(<PromptCacheStats usages={[]} events={[contextEvent(20, 100)]} />);
  expect(text(html)).toContain("总输入缓存命中率 —总输入 token 0总输出 token 0压缩次数 0上下文20%");
});

it("does not present partial preview usage or compaction counts as totals", () => {
  const events = [contextEvent(49, 100), { type: "context_compacted", record: { summaryOutcome: "accepted" } } as AgentEvent];
  const html = renderToStaticMarkup(<PromptCacheStats usages={[{ ...usage, cachedInputTokens: 50 }]} events={events} eventsComplete={false} />);
  expect(text(html)).toContain("总输入缓存命中率 —总输入 token —总输出 token —压缩次数 —上下文49%");
});

it("keeps recorded compaction counts visible even when historical usage is missing", () => {
  const events = [{ type: "context_compacted", record: { summaryOutcome: "target_fallback" } } as AgentEvent];
  expect(text(renderToStaticMarkup(<PromptCacheStats usages={[]} events={events} />))).toContain("压缩次数 1上下文—");
});
