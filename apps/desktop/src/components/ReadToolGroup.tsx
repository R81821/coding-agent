import React, { useMemo } from "react";
import { useRowState } from "@harness/conversation-ui";
import { ChevronRight, CircleAlert, CirclePause, Files, LoaderCircle } from "lucide-react";
import type { ToolGroupEntry, ToolTimelineItem } from "../conversation-stream.js";
import { groupToolEntries } from "../operation-groups.js";
import { summarizeReadTools } from "../read-tool-groups.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Marker, MarkerContent, MarkerIcon } from "../ui/marker.js";
import { Trace } from "../ui/trace.js";
import { ApprovalTraceRow, ToolTraceRow } from "./ConversationTrace.js";
import { OperationGroup } from "./OperationGroup.js";
import { ConversationHoverCard } from "./ConversationHoverCard.js";

export function ReadToolGroup({ id, tools, active }: { id: string; tools: ToolTimelineItem[]; active: boolean }) {
  const [open, setOpen] = useRowState(`readGroup:${id}:open`, false);
  const summary = useMemo(() => summarizeReadTools(tools, active), [tools, active]);
  const label = summary.runningCount ? `正在读取 ${summary.fileCount} 个文件` : summary.state === "completed"
    ? `已读取 ${summary.fileCount} 个文件` : `读取 ${summary.fileCount} 个文件`;
  const status = [
    ...(summary.failedCount ? [`${summary.failedCount} 项失败`] : []),
    ...(summary.interruptedCount ? [`${summary.interruptedCount} 项中断`] : []),
    ...(summary.callCount > summary.fileCount ? [`${summary.callCount} 次读取`] : []),
    ...(summary.runningCount ? [`${summary.completedCount + summary.failedCount}/${summary.callCount} 已结束`] : []),
  ].join(" · ");
  const Icon = summary.state === "error" ? CircleAlert : summary.runningCount ? LoaderCircle : summary.state === "interrupted" ? CirclePause : Files;
  const preview = summary.paths.slice(0, 2).join(" · ") + (summary.paths.length > 2 ? " …" : "");
  return <Collapsible open={open} onOpenChange={setOpen} className="conversation-read-group" data-read-tool-group={id} data-read-tool-group-state={summary.state}>
    <ConversationHoverCard kind="read" label={`${label}${status ? ` · ${status}` : ""}`} trigger={<Marker render={<CollapsibleTrigger />} className="conversation-read-marker">
      <MarkerIcon><Icon className={summary.state === "running" ? "animate-spin" : undefined} /></MarkerIcon>
      <MarkerContent>
        <span className="conversation-read-marker-count">{label}</span>
        {status && <span className="conversation-read-marker-status">{status}</span>}
        <span className="conversation-read-marker-preview">{preview}</span>
      </MarkerContent>
      <MarkerIcon className="conversation-read-marker-chevron"><ChevronRight /></MarkerIcon>
    </Marker>}>
      {() => <ul className="conversation-hover-paths">{summary.paths.map(path => <li key={path}>{path}</li>)}</ul>}
    </ConversationHoverCard>
    <span className="ui-trace-sr-only" role="status">{label}{status ? `，${status}` : ""}</span>
    <CollapsibleContent className="ui-trace-collapsible-content conversation-read-group-content">
      {open && <div className="conversation-read-group-list"><Trace>
        {tools.map(tool => <ToolTraceRow key={tool.started.id} tool={tool} active={active} />)}
      </Trace></div>}
    </CollapsibleContent>
  </Collapsible>;
}

export function ToolTraceList({ entries, active }: { entries: ToolGroupEntry[]; active: boolean }) {
  const rows = useMemo(() => groupToolEntries(entries), [entries]);
  return <>{rows.map(row => row.kind === "read_group"
    ? <ReadToolGroup key={`reads:${row.id}`} id={row.id} tools={row.tools} active={active} />
    : row.kind === "operation_group"
      ? <OperationGroup key={`operations:${row.id}`} id={row.id} entries={row.entries} active={active} />
      : row.kind === "approval"
        ? <ApprovalTraceRow key={`approval:${row.event.approvalId}`} event={row.event} />
        : <ToolTraceRow key={row.tool.started.id} tool={row.tool} active={active} />)}</>;
}
