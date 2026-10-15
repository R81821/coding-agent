import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent, AgentEventInput, Usage } from "@harness/protocol";
import type { SessionTurn } from "../run-history.js";
import { SessionCacheStats } from "./SessionCacheStats.js";

const at = "2026-10-11T03:00:00.000Z";
const event = (runId: string, input: AgentEventInput, sequence = 1): AgentEvent => ({ ...input, id: `${runId}-${sequence}`, runId, at, sequence });
const usage = (runId: string, value: Partial<Usage> = {}) => event(runId, { type: "usage", usage: { inputTokens: 100, outputTokens: 10, estimatedUsd: 0, ...value } });
const context = (runId: string, usedTokens: number, capacityTokens: number, source: "estimate" | "provider" = "provider") => event(runId, { type: "context_usage", context: { usedTokens, capacityTokens, source } });
const turn = (runId: string, events: AgentEvent[], extras: Partial<SessionTurn> = {}): SessionTurn => ({ runId, request: runId, status: "completed", events, ...extras });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const render = (turns: SessionTurn[], hasOlder = false) => renderToStaticMarkup(<SessionCacheStats turns={turns} hasOlder={hasOlder} />);
const compacted = (runId: string) => event(runId, { type: "context_compacted", record: {
  id: `${runId}-compaction`, runId, sourceSequenceStart: 0, sourceSequenceEnd: 1, summary: "saved context", summaryHash: "hash",
  inputTokens: 100, outputTokens: 10, deterministicFallback: false, summaryOutcome: "accepted", trust: "untrusted_tool", createdAt: at
} });
const ordered = (runId: string, events: AgentEvent[]): AgentEvent[] => events.map((value, sequence) => ({ ...value, id: `${runId}-${sequence}`, runId, sequence }));
const route = (runId: string, modelId: string, providerId = "provider") => event(runId, { type: "route", providerId, modelId, reason: "selected", estimatedUsd: 0 });

it("renders one panel with weighted cache usage and billing from the entire session", () => {
  const html = render([
    turn("first", [usage("first", { cachedInputTokens: 80 }), compacted("first"), context("first", 90, 100)]),
    turn("second", [usage("second", { inputTokens: 900, outputTokens: 22, cachedInputTokens: 180 }),
      usage("second", { purpose: "compaction", inputTokens: 200, outputTokens: 33, cachedInputTokens: 40 }), compacted("second"), context("second", 270, 1_000)])
  ]);
  expect(text(html)).toContain("总输入缓存命中率 25.0%总输入 token 1,200总输出 token 65压缩次数 2上下文27%");
  expect(html.match(/aria-label="输入缓存统计"/g)).toHaveLength(1);
  expect(html.match(/role="meter"/g)).toHaveLength(1);
  expect(html).toContain('title="270 / 1,000 tokens"');
});

it("does not sum context footprints across messages", () => {
  const html = render([turn("first", [context("first", 850_000, 1_000_000)]), turn("second", [context("second", 270_000, 1_000_000)])]);
  expect(text(html)).toContain("上下文27%");
  expect(text(html)).not.toContain("112%");
});

it("counts continuation usage once instead of adding cumulative chain totals", () => {
  const html = render([
    turn("first", [usage("first", { cachedInputTokens: 100 })]),
    turn("second", [usage("second", { cachedInputTokens: 0 }), context("second", 20, 100)], {
      continuation: { runId: "first", checkpointId: "checkpoint" },
      chainUsage: { turns: 2, tools: 0, inputTokens: 200, outputTokens: 20, usd: 0, costKnown: true }
    })
  ]);
  expect(text(html)).toContain("总输入缓存命中率 50.0%总输入 token 200总输出 token 20压缩次数 0上下文20%");
});

it("includes subagent billing while retaining the latest top-level conversation context", () => {
  const html = render([
    turn("parent", [usage("parent", { cachedInputTokens: 80 }), compacted("parent"), context("parent", 49, 100)]),
    turn("child", [usage("child", { inputTokens: 900, outputTokens: 22, cachedInputTokens: 180 }), compacted("child"), context("child", 90, 100)], { parentRunId: "parent" })
  ]);
  expect(text(html)).toContain("总输入缓存命中率 26.0%总输入 token 1,000总输出 token 32压缩次数 2上下文49%");
  expect(html.match(/role="meter"/g)).toHaveLength(1);
});

it("does not use a subagent's footprint when the next top-level request is queued", () => {
  const html = render([
    turn("parent", [context("parent", 49, 100)]),
    turn("child", [context("child", 90, 100)], { parentRunId: "parent" }),
    turn("next", [], { status: "queued" })
  ]);
  expect(text(html)).toContain("上下文49%");
});

it("keeps conversation context unknown when only subagents have been loaded", () => {
  const html = render([turn("child", [usage("child"), context("child", 90, 100)], { parentRunId: "unloaded-parent" })], true);
  expect(text(html)).toContain("总输入缓存命中率 —总输入 token —总输出 token —压缩次数 —上下文—");
  expect(html).not.toContain("aria-valuenow");
});

it("keeps the conversation measurement throughout a new run's preparation", () => {
  const previous = turn("first", [context("first", 49, 100)]);
  for (const status of ["queued", "planning", "running", "waiting_approval", "verifying"] as const) {
    const html = render([previous, turn("second", [event("second", { type: "status", status })], { status })]);
    expect(text(html)).toContain("上下文49%");
    expect(html).toContain('title="49 / 100 tokens"');
    expect(html).toContain('style="width:49%"');
  }
});

it("does not combine the prior run's capacity with a new run's usage or route", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  const newRoute = event("second", { type: "route", providerId: "provider", modelId: "different-model", reason: "selected", estimatedUsd: 0 });
  for (const events of [[usage("second")], [newRoute], [event("second", { type: "model_request_finished", purpose: "main", durationMs: 1, succeeded: true })]]) {
    const html = render([previous, turn("second", events, { status: "running" })]);
    expect(text(html)).toContain("上下文49%");
    expect(html).toContain('title="490,000 / 1,000,000 tokens"');
  }
});

it("does not replace the preceding measurement with the new round's uncalibrated initial estimate", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  const preparing = [event("second", { type: "route", providerId: "provider", modelId: "model", reason: "selected", estimatedUsd: 0 }), context("second", 90_000, 1_000_000, "estimate")];
  expect(text(render([previous, turn("second", preparing, { status: "running" })]))).toContain("上下文49%");
  const measured = [...preparing, context("second", 510_000, 1_000_000)];
  expect(text(render([previous, turn("second", measured, { status: "running" })]))).toContain("上下文51%");
});

it("updates an estimate-only provider after the main request returns", () => {
  const previous = turn("first", [context("first", 49, 100)]);
  const estimate = context("second", 54, 100, "estimate");
  expect(text(render([previous, turn("second", [estimate], { status: "running" })]))).toContain("上下文49%");
  const finished = event("second", { type: "model_request_finished", purpose: "main", durationMs: 1, succeeded: true });
  expect(text(render([previous, turn("second", [estimate, finished], { status: "running" })]))).toContain("上下文54%");
});

it("does not treat a finished request without input usage as a calibrated context measurement", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  const unmeasured = [context("second", 1_000, 1_000_000, "estimate"),
    usage("second", { inputTokens: 0, outputTokens: 100, purpose: "main" }),
    event("second", { type: "model_request_finished", purpose: "main", durationMs: 1, succeeded: true })];
  for (const status of ["running", "waiting_approval", "paused", "review", "completed", "failed"] as const) {
    const html = render([previous, turn("second", unmeasured, { status })]);
    expect(text(html)).toContain("上下文49%");
    expect(html).toContain('title="490,000 / 1,000,000 tokens"');
  }
});

it("keeps the baseline across further estimates until this run has measured its main input", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  const events = [context("second", 1_000, 1_000_000, "estimate"),
    event("second", { type: "model_request_finished", purpose: "main", durationMs: 1, succeeded: true }),
    context("second", 1_200, 1_000_000, "estimate")];
  expect(text(render([previous, turn("second", events, { status: "running" })]))).toContain("上下文49%");
  const measured = [...events, usage("second", { inputTokens: 500_000, outputTokens: 10_000, purpose: "main" })];
  expect(text(render([previous, turn("second", measured, { status: "running" })]))).toContain("上下文51%");
});

it("does not mistake rebuilding or migrating context for a committed removal of history", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  for (const kind of ["resume_rebuild", "policy_migration"] as const) {
    const preparing = [event("second", { type: "context_adjusted", adjustment: { kind, afterTokens: 1_000, capacityTokens: 1_000_000 } })];
    expect(text(render([previous, turn("second", preparing, { status: "running" })]))).toContain("上下文49%");
  }
});

it("retains a main measurement while rebuilding a paused run's next request", () => {
  const events = ordered("resumed", [
    context("resumed", 490_000, 1_000_000),
    event("resumed", { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 }),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }),
    context("resumed", 1_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("resumed", events, { status: "running" })]);
  expect(text(html)).toContain("上下文49%");
  expect(html).toContain('title="490,000 / 1,000,000 tokens"');
});

it("retains an estimate-only run's established footprint while its next request is prepared", () => {
  const events = ordered("resumed", [
    context("resumed", 490_000, 1_000_000, "estimate"),
    event("resumed", { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 }),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }),
    context("resumed", 1_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("resumed", events, { status: "running" })]);
  expect(text(html)).toContain("上下文49%");
  expect(html).toContain('title="估算 490,000 / 1,000,000 tokens"');
});

it("does not reuse an earlier compaction to authorize a later resumed estimate dropping to zero", () => {
  const events = ordered("resumed", [
    context("resumed", 850_000, 1_000_000),
    compacted("resumed"),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "full_compaction", afterTokens: 270_000, capacityTokens: 1_000_000 } }),
    context("resumed", 290_000, 1_000_000),
    event("resumed", { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 }),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }),
    context("resumed", 1_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("resumed", events, { status: "running" })]);
  expect(text(html)).toContain("上下文29%");
  expect(html).toContain('title="290,000 / 1,000,000 tokens"');
});

it("accepts a smaller actual main measurement after retaining a resumed preparation estimate", () => {
  const preparing = ordered("resumed", [
    context("resumed", 490_000, 1_000_000),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }),
    context("resumed", 1_000, 1_000_000, "estimate"),
  ]);
  expect(text(render([turn("resumed", preparing, { status: "running" })]))).toContain("上下文49%");
  const measured = ordered("resumed", [...preparing, context("resumed", 200_000, 1_000_000)]);
  const html = render([turn("resumed", measured, { status: "running" })]);
  expect(text(html)).toContain("上下文20%");
  expect(html).toContain('title="200,000 / 1,000,000 tokens"');
});

it("updates occupancy after a temporary runtime instruction is actually removed", () => {
  const events = ordered("resumed", [
    context("resumed", 490_000, 1_000_000),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "runtime_control_removed", afterTokens: 20_000, capacityTokens: 1_000_000 } }),
    context("resumed", 20_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("resumed", events, { status: "running" })]);
  expect(text(html)).toContain("上下文2%");
  expect(html).toContain('title="估算 20,000 / 1,000,000 tokens"');
});

it.each([["provider", "model-B"], ["provider-B", "model-A"]])("retains the same-capacity measurement while routing to %s/%s in the same round", (providerId, modelId) => {
  const events = ordered("rerouted", [
    route("rerouted", "model-A"),
    context("rerouted", 490_000, 1_000_000),
    event("rerouted", { type: "model_request_finished", purpose: "main", succeeded: true, durationMs: 1 }),
    route("rerouted", modelId, providerId),
    context("rerouted", 1_000, 1_000_000, "estimate"),
  ]);
  for (const previous of [[], [turn("previous", [context("previous", 390_000, 1_000_000)])]]) {
    const html = render([...previous, turn("rerouted", events, { status: "running" })]);
    expect(text(html)).toContain("上下文49%");
    expect(html).toContain('title="490,000 / 1,000,000 tokens"');
  }
});

it("accepts the new route's smaller actual provider measurement in the same round", () => {
  const preparing = ordered("rerouted", [
    route("rerouted", "model-A"),
    context("rerouted", 490_000, 1_000_000),
    route("rerouted", "model-B"),
    context("rerouted", 1_000, 1_000_000, "estimate"),
  ]);
  expect(text(render([turn("rerouted", preparing, { status: "running" })]))).toContain("上下文49%");
  const events = ordered("rerouted", [...preparing, context("rerouted", 200_000, 1_000_000)]);
  const html = render([turn("rerouted", events, { status: "running" })]);
  expect(text(html)).toContain("上下文20%");
  expect(html).toContain('title="200,000 / 1,000,000 tokens"');
});

it("uses the new route's actual capacity when the model changes within a single round", () => {
  const events = ordered("rerouted", [
    route("rerouted", "model-A"),
    context("rerouted", 490_000, 1_000_000),
    route("rerouted", "model-B"),
    context("rerouted", 55_000, 128_000, "estimate"),
  ]);
  const html = render([turn("rerouted", events, { status: "running" })]);
  expect(text(html)).toContain("上下文43%");
  expect(html).toContain('title="估算 55,000 / 128,000 tokens"');
});

it("does not allow a pending compaction estimate to cross a resume boundary", () => {
  const events = ordered("resumed", [
    context("resumed", 490_000, 1_000_000),
    compacted("resumed"),
    event("resumed", { type: "context_adjusted", adjustment: { kind: "resume_rebuild" } }),
    context("resumed", 1_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("resumed", events, { status: "running" })]);
  expect(text(html)).toContain("上下文49%");
  expect(html).toContain('title="490,000 / 1,000,000 tokens"');
});

it("accepts the estimate immediately after a committed compaction in a single round", () => {
  const events = ordered("compacted", [
    context("compacted", 850_000, 1_000_000),
    compacted("compacted"),
    context("compacted", 270_000, 1_000_000, "estimate"),
  ]);
  const html = render([turn("compacted", events, { status: "running" })]);
  expect(text(html)).toContain("上下文27%");
  expect(html).toContain('title="估算 270,000 / 1,000,000 tokens"');
});

it("updates committed compaction immediately even before the new main request responds", () => {
  const previous = turn("first", [context("first", 85, 100)]);
  const compactedEvents = [context("second", 86, 100, "estimate"), compacted("second"), context("second", 27, 100, "estimate")];
  expect(text(render([previous, turn("second", compactedEvents, { status: "running" })]))).toContain("上下文27%");
  const pruned = [event("second", { type: "context_adjusted", adjustment: { kind: "tool_prune", afterTokens: 30, capacityTokens: 100 } })];
  expect(text(render([previous, turn("second", pruned, { status: "running" })]))).toContain("上下文30%");
});

it("uses a newly measured model capacity without combining it with the preceding footprint", () => {
  const previous = turn("first", [context("first", 490_000, 1_000_000)]);
  const html = render([previous, turn("second", [context("second", 55_000, 128_000, "estimate")], { status: "running" })]);
  expect(text(html)).toContain("上下文43%");
  expect(html).toContain('title="估算 55,000 / 128,000 tokens"');
});

it("skips several preparing rounds and never borrows a subagent or withdrawn footprint", () => {
  const previous = turn("first", [context("first", 49, 100)]);
  const html = renderToStaticMarkup(<SessionCacheStats turns={[previous, turn("second", [], { status: "failed" }), turn("child", [context("child", 90, 100)], { parentRunId: "second" }), turn("third", [], { status: "planning" })]}
    withdrawnEvents={[context("withdrawn", 99, 100)]} />);
  expect(text(html)).toContain("上下文49%");
  expect(html.match(/role="meter"/g)).toHaveLength(1);
});

it("uses a legacy measurement and capacity from the latest run itself", () => {
  const html = render([
    turn("first", [context("first", 490_000, 1_000_000)]),
    turn("second", [event("second", { type: "context_adjusted", adjustment: { kind: "full_compaction", afterTokens: 56_521, capacityTokens: 128_000 } }),
      usage("second", { inputTokens: 54_098, outputTokens: 1_189 })])
  ]);
  expect(text(html)).toContain("上下文43%");
  expect(html).toContain('title="55,287 / 128,000 tokens"');
});

it("keeps totals unknown until all runs and their events are loaded, while showing current context", () => {
  const previous = turn("first", [usage("first", { cachedInputTokens: 100 })]);
  const current = turn("second", [context("second", 49, 100)]);
  for (const html of [
    render([previous, current], true),
    render([{ ...previous, view: { lastSequence: 10, eventsComplete: false } }, current])
  ]) {
    expect(text(html)).toContain("总输入缓存命中率 —总输入 token —总输出 token —压缩次数 —上下文49%");
  }
  expect(text(render([previous, current]))).toContain("总输入 token 100总输出 token 10压缩次数 0上下文49%");
});

it("clears measurements and cumulative metrics when a fresh session has no recorded data", () => {
  expect(text(render([turn("existing", [usage("existing"), context("existing", 49, 100)])]))).toContain("上下文49%");
  expect(render([])).toBe("");
  expect(render([turn("fresh", [], { status: "queued" })])).toBe("");
});

it("keeps spending from withdrawn rounds while returning context to the previous visible conversation", () => {
  const html = renderToStaticMarkup(<SessionCacheStats turns={[turn("remaining", [usage("remaining", { cachedInputTokens: 80 }), context("remaining", 27, 100)])]}
    withdrawnEvents={[usage("withdrawn", { inputTokens: 900, outputTokens: 22, cachedInputTokens: 180 }), compacted("withdrawn")]} />);
  expect(text(html)).toContain("总输入缓存命中率 26.0%总输入 token 1,000总输出 token 32压缩次数 1上下文27%");
  expect(html).toContain('title="27 / 100 tokens"');
});

it("shows spent totals with unknown context after the only round was withdrawn", () => {
  const html = renderToStaticMarkup(<SessionCacheStats turns={[]} withdrawnEvents={[usage("withdrawn", { cachedInputTokens: 80 }), compacted("withdrawn")]} />);
  expect(text(html)).toContain("总输入缓存命中率 80.0%总输入 token 100总输出 token 10压缩次数 1上下文—");
  expect(html).not.toContain("aria-valuenow");
});
