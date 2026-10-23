import type { AgentEvent } from "@harness/protocol";
import type { ToolGroupEntry } from "./conversation-stream.js";
import { getToolTraceState, type ToolTraceState } from "./conversation-trace.js";
import { groupReadTools, localReadPath, type ReadToolGroupItem } from "./read-tool-groups.js";
import { toolActivity } from "./tool-summary.js";
import { isLocalFileEdit } from "./code-changes.js";

type ApprovalRequiredEvent = Extract<AgentEvent, { type: "approval_required" }>;

export type OperationKind = "edit" | "run";

export type ToolGroupRow =
  | ReadToolGroupItem
  | { kind: "operation_group"; id: string; entries: ToolGroupEntry[] }
  | { kind: "approval"; event: ApprovalRequiredEvent };

export type OperationSummary = {
  label: string;
  state: ToolTraceState;
};

// One sentence describes what a collapsed run did, so the fixed order stays predictable.
const operationLabels: Array<[OperationKind, string]> = [
  ["edit", "编辑了文件"],
  ["run", "运行了命令"],
];

/** A remote tool can share a built-in name while having different semantics. */
function operationKind(entry: Extract<ToolGroupEntry, { kind: "tool" }>): OperationKind {
  const { call, origin } = entry.tool.started;
  // Every non-edit call keeps the verb the individual row would show for it.
  return !origin && toolActivity(call.name, call.input).verb === "编辑了文件" ? "edit" : "run";
}

// Rows keep the identity the read groups already use: the tool event id, or the approval's own id.
function entryId(entry: ToolGroupEntry): string {
  return entry.kind === "tool" ? entry.tool.started.id : entry.event.approvalId;
}

/** Compress adjacent reads and command/approval groups. Local file edits keep their own
 * visible row so their confirmed changes can be inspected directly. */
export function groupToolEntries(entries: ToolGroupEntry[]): ToolGroupRow[] {
  const rows: ToolGroupRow[] = [];
  let index = 0;
  while (index < entries.length) {
    const first = entries[index]!;
    if (first.kind === "tool" && isLocalFileEdit(first.tool.started)) {
      rows.push({ kind: "tool", tool: first.tool });
      index++;
      continue;
    }
    if (first.kind === "tool" && localReadPath(first.tool) !== undefined) {
      let end = index + 1;
      while (end < entries.length) {
        const entry = entries[end]!;
        if (entry.kind !== "tool" || localReadPath(entry.tool) === undefined) break;
        if (entry.tool.started.runId !== first.tool.started.runId) break;
        end++;
      }
      rows.push(...groupReadTools(entries.slice(index, end).flatMap(entry => entry.kind === "tool" ? [entry.tool] : [])));
      index = end;
      continue;
    }
    let end = index;
    while (end < entries.length) {
      const entry = entries[end]!;
      if (entry.kind === "tool" && (localReadPath(entry.tool) !== undefined || isLocalFileEdit(entry.tool.started))) break;
      end++;
    }
    const run = entries.slice(index, end);
    const head = run[0]!;
    if (run.length > 1) rows.push({ kind: "operation_group", id: entryId(head), entries: run });
    else if (head.kind === "tool") rows.push({ kind: "tool", tool: head.tool });
    else rows.push({ kind: "approval", event: head.event });
    index = end;
  }
  return rows;
}

export function summarizeOperations(entries: ToolGroupEntry[], active: boolean): OperationSummary {
  const kinds = new Set<OperationKind>();
  let failedCount = 0;
  let runningCount = 0;
  let interruptedCount = 0;
  for (const entry of entries) {
    // An approval gates its call; it never changes what the run did or how it ended.
    if (entry.kind !== "tool") continue;
    kinds.add(operationKind(entry));
    const state = getToolTraceState(entry.tool.started, entry.tool.finished, active);
    if (state === "error") failedCount++;
    else if (state === "running") runningCount++;
    else if (state === "interrupted") interruptedCount++;
  }
  return {
    label: operationLabels.filter(([kind]) => kinds.has(kind)).map(([, label]) => label).join("，"),
    // Surface a failed command even while its neighbours are still running.
    state: failedCount ? "error" : runningCount ? "running" : interruptedCount ? "interrupted" : "completed",
  };
}
