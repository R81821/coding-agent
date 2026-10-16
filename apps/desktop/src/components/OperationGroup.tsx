import React, { useMemo } from "react";
import { useRowState } from "@harness/conversation-ui";
import { ChevronRight, CircleAlert, CircleCheck, CirclePause, LoaderCircle } from "lucide-react";
import type { ToolGroupEntry } from "../conversation-stream.js";
import { summarizeOperations } from "../operation-groups.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Marker, MarkerContent, MarkerIcon } from "../ui/marker.js";
import { Trace } from "../ui/trace.js";
import { ApprovalTraceRow, ToolTraceRow } from "./ConversationTrace.js";
import { ConversationHoverCard } from "./ConversationHoverCard.js";

/** A run of commands, file edits and the approvals that gate them collapses to the one
 * sentence describing what it did. Every call keeps its own row once expanded. */
export function OperationGroup({ id, entries, active }: { id: string; entries: ToolGroupEntry[]; active: boolean }) {
  const [open, setOpen] = useRowState(`operationGroup:${id}:open`, false);
  const summary = useMemo(() => summarizeOperations(entries, active), [entries, active]);
  const Icon = summary.state === "error" ? CircleAlert : summary.state === "running" ? LoaderCircle : summary.state === "interrupted" ? CirclePause : CircleCheck;
  return <Collapsible open={open} onOpenChange={setOpen} className="conversation-operation-group" data-operation-group={id} data-operation-group-state={summary.state}>
    <ConversationHoverCard kind="operation" label={summary.label} trigger={<Marker render={<CollapsibleTrigger />} className="conversation-operation-marker">
      <MarkerIcon><Icon className={summary.state === "running" ? "animate-spin" : undefined} /></MarkerIcon>
      <MarkerContent><span className="conversation-operation-marker-label">{summary.label}</span></MarkerContent>
      <MarkerIcon className="conversation-operation-marker-chevron"><ChevronRight /></MarkerIcon>
    </Marker>}>
      {() => <p className="conversation-hover-meta">
        {entries.filter(entry => entry.kind === "tool").length} 项操作
        {entries.some(entry => entry.kind === "approval") ? ` · ${entries.filter(entry => entry.kind === "approval").length} 条审批请求` : ""}
      </p>}
    </ConversationHoverCard>
    <span className="ui-trace-sr-only" role="status">{summary.label}</span>
    <CollapsibleContent className="ui-trace-collapsible-content conversation-operation-group-content">
      {open && <div className="conversation-operation-group-list"><Trace>
        {entries.map(entry => entry.kind === "tool"
          ? <ToolTraceRow key={entry.tool.started.id} tool={entry.tool} active={active} />
          : <ApprovalTraceRow key={entry.event.approvalId} event={entry.event} />)}
      </Trace></div>}
    </CollapsibleContent>
  </Collapsible>;
}
