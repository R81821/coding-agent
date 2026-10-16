import type { AgentEvent } from "@harness/protocol";
import { messageHttpUrl } from "./message-links.js";

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;

export type ToolTraceState = "running" | "completed" | "error" | "interrupted";
export type ConversationSource = { url: string; title: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function structuredOutput(value: unknown): Record<string, unknown> | undefined {
  // Historical output hydration returns JSON text; live events already hold the object.
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return record(value);
}

function hasError(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  return value !== undefined && value !== null && value !== false;
}

export function getToolTraceState(started: ToolStartedEvent, finished: ToolFinishedEvent | undefined, active: boolean): ToolTraceState {
  if (!finished) return active ? "running" : "interrupted";
  // The engine can deliberately mark an expected nonzero exit (e.g. no search matches)
  // as successful. Its explicit verdict takes priority over output heuristics.
  if (typeof finished.isError === "boolean") return finished.isError ? "error" : "completed";
  const output = structuredOutput(finished.output);
  if (!output) return "completed";
  if (typeof output.isError === "boolean") return output.isError ? "error" : "completed";
  if (hasError(output.error) || output.timedOut === true || output.timeout === true ||
    output.status === "timeout" || output.status === "timed_out") return "error";
  if (["terminal", "bash", "runCommand", "run_command", "exec_command"].includes(started.call.name) &&
    (output.exitCode === null || (typeof output.exitCode === "number" && output.exitCode !== 0))) return "error";
  return "completed";
}

const documentActions = new Set(["navigate", "new_tab", "snapshot", "screenshot", "back", "forward", "reload"]);

function sourceKind(started: ToolStartedEvent): "search" | "document" | undefined {
  if (started.call.name === "web_search") return "search";
  if (started.call.name === "browser" && documentActions.has(String(started.call.input.action))) return "document";
  return undefined;
}

/** Sources belong to the human-message segment where their tool started, even if
 * its result arrives after another human message. Keep canonical event order. */
export function sourceEventsForSegment(allEvents: AgentEvent[], segmentEvents: AgentEvent[]): AgentEvent[] {
  const calls = new Set(segmentEvents.flatMap(event => event.type === "tool_started" && sourceKind(event)
    ? [`${event.runId}\0${event.call.id}`] : []));
  if (!calls.size) return [];
  return allEvents.filter(event => event.type === "tool_started"
    ? calls.has(`${event.runId}\0${event.call.id}`)
    : event.type === "tool_finished" && calls.has(`${event.runId}\0${event.callId}`));
}

export function extractConversationSources(events: AgentEvent[]): { sources: ConversationSource[]; pending: boolean } {
  const calls = new Map<string, ToolStartedEvent>();
  const sources = new Map<string, ConversationSource>();
  let pending = false;
  const add = (value: unknown) => {
    const source = record(value);
    const url = messageHttpUrl(source?.url);
    if (!url) return;
    const title = typeof source?.title === "string" && source.title.trim() ? source.title.trim() : new URL(url).hostname;
    const existing = sources.get(url);
    if (!existing || (existing.title === new URL(url).hostname && title !== existing.title)) sources.set(url, { url, title });
  };
  for (const event of events) {
    if (event.type === "tool_started") {
      calls.set(`${event.runId}\0${event.call.id}`, event);
      continue;
    }
    if (event.type !== "tool_finished") continue;
    const started = calls.get(`${event.runId}\0${event.callId}`);
    if (!started || getToolTraceState(started, event, false) !== "completed") continue;
    const kind = sourceKind(started);
    if (!kind) continue;
    const output = structuredOutput(event.output);
    if (!output) continue;
    if (output.deferred === true) { pending = true; continue; }
    // Only consume the tool's documented result fields. URLs printed in stdout,
    // excerpts, DOM links, tab lists, or arbitrary nested objects are not sources.
    if (kind === "search") {
      if (Array.isArray(output.results)) for (const result of output.results) add(result);
    } else {
      add(output);
    }
  }
  return { sources: [...sources.values()], pending };
}
