import type { ToolTimelineItem } from "./conversation-stream.js";
import { getToolTraceState, type ToolTraceState } from "./conversation-trace.js";

export type ReadToolGroupItem =
  | { kind: "read_group"; id: string; tools: ToolTimelineItem[] }
  | { kind: "tool"; tool: ToolTimelineItem };

export type ReadToolsSummary = {
  fileCount: number;
  callCount: number;
  completedCount: number;
  failedCount: number;
  interruptedCount: number;
  runningCount: number;
  paths: string[];
  state: ToolTraceState;
};

export function localReadPath(tool: ToolTimelineItem): string | undefined {
  const { call, origin } = tool.started;
  // A remote tool can share a built-in name while having different semantics.
  if (origin || (call.name !== "read_file" && call.name !== "read_range")) return undefined;
  const path = call.input.path;
  return typeof path === "string" && path.trim() ? path.replaceAll("\\", "/") : undefined;
}

/** Compress adjacent local reads inside one existing tool group, retaining every
 * original call and its position for per-call details and result hydration. */
export function groupReadTools(tools: ToolTimelineItem[]): ReadToolGroupItem[] {
  const items: ReadToolGroupItem[] = [];
  let index = 0;
  while (index < tools.length) {
    const first = tools[index]!;
    if (localReadPath(first) === undefined) {
      items.push({ kind: "tool", tool: first });
      index++;
      continue;
    }
    let end = index + 1;
    while (end < tools.length && tools[end]!.started.runId === first.started.runId && localReadPath(tools[end]!) !== undefined) end++;
    if (end - index >= 2) {
      items.push({ kind: "read_group", id: first.started.id, tools: tools.slice(index, end) });
    } else {
      items.push({ kind: "tool", tool: first });
    }
    index = end;
  }
  return items;
}

export function summarizeReadTools(tools: ToolTimelineItem[], active: boolean): ReadToolsSummary {
  const paths = new Set<string>();
  let completedCount = 0;
  let failedCount = 0;
  let interruptedCount = 0;
  let runningCount = 0;
  for (const tool of tools) {
    const path = localReadPath(tool);
    if (path !== undefined) paths.add(path);
    const state = getToolTraceState(tool.started, tool.finished, active);
    if (state === "completed") completedCount++;
    else if (state === "error") failedCount++;
    else if (state === "interrupted") interruptedCount++;
    else runningCount++;
  }
  return {
    fileCount: paths.size,
    callCount: tools.length,
    completedCount,
    failedCount,
    interruptedCount,
    runningCount,
    paths: [...paths],
    // Surface a failed read even while adjacent reads are still running.
    state: failedCount ? "error" : runningCount ? "running" : interruptedCount ? "interrupted" : "completed",
  };
}
