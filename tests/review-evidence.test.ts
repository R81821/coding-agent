import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { AgentEvent, ToolCall, WorkflowState } from "@harness/protocol";
import { descriptor } from "@harness/providers";
import { buildReviewEvidence } from "../packages/core/src/review-evidence.js";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { prepareReviewRequest } from "../packages/core/src/independent-review.js";

type Observation = WorkflowState["observations"][number];
function fixture() {
  const state = new LightweightWorkflow("Analyze code and open the HTML in the built-in browser", () => {}).state;
  state.epoch = "epoch-review";
  state.revision = 2;
  const events: AgentEvent[] = [];
  let sequence = 0;
  function add(id: string, name: string, input: ToolCall["input"], output: unknown, overrides: Partial<Observation> = {}) {
    const call = { id, name, input };
    const base = { runId: "run-review", at: "2026-10-09T00:00:00.000Z" };
    events.push({ ...base, id: `${id}-started`, sequence: ++sequence, type: "tool_started", call });
    events.push({ ...base, id: `${id}-finished`, sequence: ++sequence, type: "tool_finished", callId: id, output, durationMs: 1, isError: overrides.failed ?? false });
    const observed: Observation = { id, tool: name, target: JSON.stringify(input), summary: "tool preview", epoch: state.epoch, revision: state.revision, sequence, failed: false, complete: true, failureId: "", digest: "", kind: "tool", ...overrides };
    state.observations.push(observed);
    return observed;
  }
  function receipt(ids: string[], diffObservationId = "") {
    state.requirementReceipts = [{ requirementId: "req-1", summary: "Final report", observationIds: ids, verificationIds: [], diffObservationId }];
    state.reviewEvidenceIds = ids;
  }
  return { state, events, add, receipt };
}

it("supplies current raw HTML and built-in browser evidence beyond the diff receipt", () => {
  const f = fixture();
  f.add("old-html", "read_file", { path: "index.html", offset: 1, limit: 40 }, "old HTML", { revision: 1 });
  f.add("html", "read_file", { path: "index.html", offset: 1, limit: 40 }, { path: "index.html", content: "<html><svg>actual source</svg></html>", returnedLines: 1 });
  f.add("browser", "browser", { action: "tabs" }, { activeTabId: "tab", visible: true, tabs: [{ id: "tab", url: "file:///D:/project/index.html", title: "SVG demo", loading: false }] });
  f.add("diff", "workspace_diff", {}, { complete: true, files: ["check.py"] });
  f.add("failed", "terminal", { command: "broken" }, "failure", { failed: true });
  f.add("truncated", "read_file", { path: "large.html" }, "preview only", { complete: false });
  f.add("verification", "verification:local", {}, "check output", { kind: "verification" });
  f.receipt(["diff"], "diff");
  const result = buildReviewEvidence({ ...f, modern: true, diffObservationId: "diff" });
  expect(result.missingEvidenceIds).toEqual([]);
  expect(result.observations.map(item => item.id)).toEqual(["diff", "html", "browser"]);
  expect(result.observations.find(item => item.id === "html")).toMatchObject({ input: { path: "index.html", offset: 1, limit: 40 }, output: { content: "<html><svg>actual source</svg></html>" } });
  expect(result.observations.find(item => item.id === "browser")?.output).toMatchObject({ visible: true, tabs: [{ url: "file:///D:/project/index.html", loading: false }] });
});

it("expands a currently reconfirmed cached read from the exact historical range", () => {
  const f = fixture(), input = { path: "index.html", offset: 96, limit: 36 };
  f.add("source", "read_file", input, { path: "index.html", offset: 96, returnedLines: 36, content: "original full requested range", hasMore: true, nextOffset: 132 }, { revision: 1 });
  f.add("current", "read_file", input, { reusedEvidenceId: "source", unchanged: true, truncated: false, offset: 96, returnedLines: 36 });
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.missingEvidenceIds).toEqual([]);
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]).toMatchObject({ id: "current", revision: 2, sourceEvidenceId: "source", reconfirmed: true, output: { content: "original full requested range", hasMore: true, nextOffset: 132 } });
});

it.each(["range", "tool", "epoch", "future-revision", "source-failed", "source-truncated", "source-missing", "source-call-missing", "not-reconfirmed", "reuse-truncated"])("rejects unsupported cached evidence: %s", reason => {
  const f = fixture(), input = { path: "index.html", offset: 10, limit: 20 };
  const source = f.add("source", "read_file", input, "original HTML", { revision: 1 });
  const reuse: Record<string, unknown> = { reusedEvidenceId: "source", unchanged: true, truncated: false };
  if (reason === "range") f.events.splice(0, f.events.length, ...f.events.map(event => event.type === "tool_started" ? { ...event, call: { ...event.call, input: { ...input, limit: 40 } } } : event));
  if (reason === "tool") source.tool = "read_range";
  if (reason === "epoch") source.epoch = "previous-epoch";
  if (reason === "future-revision") source.revision = 3;
  if (reason === "source-failed") source.failed = true;
  if (reason === "source-truncated") source.complete = false;
  if (reason === "source-missing") f.state.observations = [];
  if (reason === "source-call-missing") f.events.splice(0, f.events.length, ...f.events.filter(event => event.type !== "tool_started"));
  if (reason === "not-reconfirmed") reuse.unchanged = false;
  if (reason === "reuse-truncated") reuse.truncated = true;
  f.add("current", "read_file", input, reuse);
  expect(f.events.some(event => event.type === "tool_finished" && event.callId === "current")).toBe(true);
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations).toEqual([]);
  expect(result.missingEvidenceIds).toContain("current");
});

it("does not elevate old browser or file evidence cited by a report to the current revision", () => {
  const f = fixture();
  f.add("old-browser", "browser", { action: "tabs" }, { tabs: [{ url: "file:///index.html" }] }, { revision: 1 });
  f.add("old-html", "read_file", { path: "index.html" }, "old HTML", { revision: 1 });
  f.receipt(["old-browser", "old-html", "missing-original"]);
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations).toEqual([]);
  expect(result.missingEvidenceIds).toEqual(["old-browser", "old-html", "missing-original"]);
});

it("reports missing or unsuccessful raw events instead of silently omitting current evidence", () => {
  const f = fixture();
  f.add("missing", "read_file", { path: "index.html" }, "HTML");
  f.add("error", "browser", { action: "tabs" }, "browser unavailable");
  f.events = f.events.filter(event => event.type !== "tool_finished" || event.callId !== "missing").map(event => event.type === "tool_finished" && event.callId === "error" ? { ...event, isError: true } : event);
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations).toEqual([]);
  expect(result.missingEvidenceIds).toEqual(["missing", "error"]);
});

it("requires original call provenance and complete raw diff records", () => {
  const f = fixture();
  f.add("no-input", "read_file", { path: "index.html" }, "HTML");
  f.add("diff", "workspace_diff", {}, { complete: false, files: ["omitted.py"] });
  f.events = f.events.filter(event => event.type !== "tool_started" || event.call.id !== "no-input");
  f.receipt(["diff"], "diff");
  const result = buildReviewEvidence({ ...f, modern: true, diffObservationId: "diff" });
  expect(result.observations).toEqual([]);
  expect(result.missingEvidenceIds).toEqual(["diff", "no-input"]);
});

it("rejects cyclic reuse and unsuccessful required evidence", () => {
  const f = fixture(), input = { path: "index.html", offset: 1, limit: 40 };
  f.add("cycle-a", "read_file", input, { reusedEvidenceId: "cycle-b", unchanged: true });
  f.add("cycle-b", "read_file", input, { reusedEvidenceId: "cycle-a", unchanged: true });
  f.add("failed", "read_file", input, "read failed", { failed: true });
  f.receipt(["failed"]);
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations).toEqual([]);
  expect(result.missingEvidenceIds).toEqual(["failed", "cycle-a", "cycle-b"]);
});

it("keeps legacy review selection restricted to explicit receipts", () => {
  const f = fixture();
  f.add("html", "read_file", { path: "index.html" }, "HTML");
  f.add("diff", "git_diff", {}, "diff content");
  f.receipt(["diff"], "diff");
  const result = buildReviewEvidence({ ...f, modern: false });
  expect(result.missingEvidenceIds).toEqual([]);
  expect(result.observations.map(item => item.id)).toEqual(["diff"]);
  expect(result.observations[0]?.output).toBe("diff content");
});

it("references the supplied diff and repeated identical raw outputs once", () => {
  const f = fixture(), input = { path: "index.html", offset: 1, limit: 40 }, text = "raw file content".repeat(400);
  f.add("diff", "workspace_diff", {}, "large diff".repeat(400));
  f.add("diff-again", "workspace_diff", {}, "large diff".repeat(400));
  f.add("html-a", "read_file", input, text);
  f.add("html-b", "read_file", input, text);
  const result = buildReviewEvidence({ ...f, modern: true, diffObservationId: "diff" });
  expect(result.observations[0]).toMatchObject({ id: "diff", outputReference: "diff" });
  expect(result.observations[0]).not.toHaveProperty("output");
  expect(result.observations[1]).toMatchObject({ id: "diff-again", outputReference: "diff" });
  expect(result.observations[1]).not.toHaveProperty("output");
  expect(result.observations[2]?.output).toBe(text);
  expect(result.observations[3]).toMatchObject({ id: "html-b", outputReference: "observation:html-a" });
  expect(result.observations[3]).not.toHaveProperty("output");
});

it("keeps screenshot provenance and states that binary pixels are omitted", () => {
  const f = fixture(), bytes = Buffer.from("fixture-image-bytes"), base64 = bytes.toString("base64");
  f.add("shot", "browser", { action: "screenshot", tabId: "tab" }, { tabId: "tab", url: "file:///D:/project/index.html", title: "SVG demo", mimeType: "image/png", base64 });
  f.add("uri-shot", "browser", { action: "screenshot", tabId: "other-tab" }, { tabId: "other-tab", url: "file:///D:/project/index.html", mimeType: "image/png", artifactUri: "artifact://browser/screenshot.png" });
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations[0]?.output).toMatchObject({ tabId: "tab", url: "file:///D:/project/index.html", mimeType: "image/png", binaryEvidence: { omitted: true, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  expect(result.observations[0]?.output).not.toHaveProperty("base64");
  expect(JSON.stringify(result.observations)).not.toContain(base64);
  expect(result.observations[1]?.output).toHaveProperty("artifactUri", "artifact://browser/screenshot.png");
  expect((f.events.find(event => event.type === "tool_finished" && event.callId === "shot") as Extract<AgentEvent, { type: "tool_finished" }>).output).toHaveProperty("base64", base64);
});

it("preserves the whole selected evidence and explicitly rejects context overflow", () => {
  const f = fixture(), content = "source line with essential final assertion\n".repeat(1000);
  f.add("html", "read_file", { path: "index.html" }, { content });
  const result = buildReviewEvidence({ ...f, modern: true });
  expect(result.observations[0]?.output).toEqual({ content });
  const model = descriptor({ providerId: "fake", modelId: "small", displayName: "Small", maxContextTokens: 5000 });
  expect(() => prepareReviewRequest({ state: f.state, runId: "review", model, diff: "diff", observations: result.observations, verificationRuns: [] })).toThrow("context_budget_exceeded");
});
