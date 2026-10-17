import React, { useMemo, useState } from "react";
import { useRowState } from "@harness/conversation-ui";
import { isDeferredOutput } from "@harness/protocol";
import { ArrowUpRight, Brain, CircleAlert, CircleCheck, CirclePause, Globe, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ToolTimelineItem } from "../conversation-stream.js";
import { approvalTraceSummary } from "../approval-trace.js";
import { extractConversationSources, getToolTraceState } from "../conversation-trace.js";
import type { AgentEvent } from "@harness/protocol";
import { toolActivity, toolSummary } from "../tool-summary.js";
import { MarkdownMessage } from "../markdown-message.js";
import { ConversationHoverCard } from "./ConversationHoverCard.js";
import { CodeBlock, CodeBlockContent } from "../ui/code-block.js";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../ui/trace.js";

function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round(ms % 60_000 / 1000)} 秒`;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function ToolTraceRow({ tool, active }: { tool: ToolTimelineItem; active: boolean }) {
  const { started, finished } = tool;
  const [open, setOpen] = useRowState(`tool:${started.id}:open`, false);
  const state = getToolTraceState(started, finished, active);
  const summary = toolSummary(started.call.name, started.call.input, started.origin);
  const activity = toolActivity(started.call.name, started.call.input);
  const terminal = !started.origin && summary.kind === "command";
  const localRead = !started.origin && ["read_file", "read_range"].includes(started.call.name);
  const input = started.call.input;
  const start = input.startLine ?? input.offset;
  const end = input.endLine ?? (typeof start === "number" && typeof input.limit === "number" ? start + input.limit - 1 : undefined);
  const range = localRead && typeof start === "number" ? ` · 第 ${start}${typeof end === "number" ? `–${end}` : ""} 行` : "";
  const commandPrefix = terminal && ["probe", "run_verification"].includes(started.call.name) && summary.detail ? `${started.call.name} · ` : "";
  const detail = commandPrefix + (summary.detail || summary.label) + range;
  const preview = terminal ? detail.replace(/\s+/g, " ").trim() : detail;
  const label = localRead ? state === "running" ? "正在读取" : state === "error" ? "读取失败" : state === "interrupted" ? "读取已中断" : "已读取"
    : state === "running" ? "正在执行" : state === "error" ? "执行失败" : state === "interrupted" ? "执行已中断" : activity.verb;
  const Icon = state === "running" ? LoaderCircle : state === "error" ? CircleAlert : state === "interrupted" ? CirclePause : CircleCheck;
  return <TraceCollapsible open={open} onOpenChange={setOpen} className={terminal ? "conversation-terminal-row" : ""} data-tool-call-id={started.call.id} data-tool-name={started.call.name} data-tool-state={state} data-conversation-terminal={terminal || undefined}>
    <ConversationHoverCard kind="tool" label={`${label} · ${summary.label}`} trigger={<TraceCollapsibleTrigger className={terminal ? "conversation-terminal-trigger" : ""}>
      <TraceLine {...(state === "running" || state === "error" ? { status: state } : state === "interrupted" && !terminal ? { status: "pending" as const } : {})}>
        <TraceIcon className={terminal ? "conversation-terminal-status-icon" : ""}><Icon className={state === "running" ? "animate-spin" : undefined} /></TraceIcon>
        <TraceTitle className={terminal ? "conversation-terminal-command" : ""}>{label} {preview}</TraceTitle>
        {finished && !terminal && <TraceDescription>{durationLabel(finished.durationMs)}</TraceDescription>}
      </TraceLine>
    </TraceCollapsibleTrigger>}>
      {() => <>
        <p className="conversation-hover-code">{detail}</p>
        {finished && <p className="conversation-hover-meta">执行用时 {durationLabel(finished.durationMs)}</p>}
      </>}
    </ConversationHoverCard>
    <TraceCollapsibleContent>
      {open && <div className="conversation-trace-tool-detail">
        {terminal && <>
          <span className="conversation-trace-detail-label">完整命令</span>
          <CodeBlock size="sm"><CodeBlockContent wrap>{typeof input.command === "string" ? input.command : detail}</CodeBlockContent></CodeBlock>
          {finished && <span className="conversation-terminal-duration">执行用时 {durationLabel(finished.durationMs)}</span>}
        </>}
        <span className="conversation-trace-detail-label">输入参数</span>
        <CodeBlock size="sm"><CodeBlockContent wrap>{outputText(started.call.input)}</CodeBlockContent></CodeBlock>
        {finished ? <>
          <span className="conversation-trace-detail-label">执行输出</span>
          {isDeferredOutput(finished.output) ? <p role="status">正在同步工具输出…</p> :
            <CodeBlock size="sm" {...(state === "error" ? { variant: "destructive" as const } : {})}><CodeBlockContent wrap>{outputText(finished.output)}</CodeBlockContent></CodeBlock>}
        </> : <p role="status">{state === "running" ? "等待执行结果…" : "此记录没有完成结果。"}</p>}
      </div>}
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** The request behind an approval stays one line until the reader asks for the raw payload. */
export function ApprovalTraceRow({ event }: { event: Extract<AgentEvent, { type: "approval_required" }> }) {
  const [open, setOpen] = useRowState(`approval:${event.approvalId}:open`, false);
  const summary = useMemo(() => approvalTraceSummary(event.summary), [event.summary]);
  const riskLabel = { read: "只读", write: "写入", high: "高风险", destructive: "破坏性" }[event.risk];
  return <TraceCollapsible open={open} onOpenChange={setOpen} className="conversation-terminal-row conversation-approval-row" data-conversation-approval={event.approvalId} data-approval-risk={event.risk}>
    <ConversationHoverCard kind="approval" label={`审批请求 · ${riskLabel}`} trigger={<TraceCollapsibleTrigger className="conversation-terminal-trigger">
      <TraceLine>
        <TraceIcon><TriangleAlert /></TraceIcon>
        <TraceTitle className="conversation-terminal-command">审批请求 {summary.title}</TraceTitle>
        <TraceDescription>{riskLabel}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>}>
      {() => <p className="conversation-hover-code">{summary.command ? `${summary.toolName} · ${summary.command}` : summary.title}</p>}
    </ConversationHoverCard>
    <TraceCollapsibleContent>
      {open && <div className="conversation-trace-tool-detail">
        <span className="conversation-trace-detail-label">审批请求记录</span>
        <CodeBlock size="sm"><CodeBlockContent wrap>{event.summary}</CodeBlockContent></CodeBlock>
      </div>}
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

export function ReasoningTraceRow({ id, text, running = false }: { id: string; text: string; running?: boolean }) {
  const [open, setOpen] = useRowState<boolean | undefined>(`reasoning:${id}:open`, undefined);
  return <TraceCollapsible open={open ?? running} onOpenChange={setOpen} data-conversation-reasoning="true" data-summary-available="true">
    <TraceCollapsibleTrigger>
      <TraceLine {...(running ? { status: "running" as const } : {})}>
        <TraceIcon>{running ? <LoaderCircle className="animate-spin" /> : <Brain />}</TraceIcon>
        <TraceTitle>{running ? "正在思考" : "思考摘要"}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent><div className="conversation-reasoning-text"><MarkdownMessage text={text} compact isStreaming={running} /></div></TraceCollapsibleContent>
  </TraceCollapsible>;
}

export function ProcessTraceRow({ id, text, live }: { id: string; text: string; live: boolean }) {
  return <div className="conversation-process-message" data-conversation-process-message={id} data-streaming={String(live)} aria-label="过程对话" aria-busy={live}>
    <MarkdownMessage text={text} compact isStreaming={live} />
  </div>;
}

export function SourcesTraceRow({ events, stateKey }: { events: AgentEvent[]; stateKey: string }) {
  const { sources, pending } = useMemo(() => extractConversationSources(events), [events]);
  const [open, setOpen] = useRowState(`sources:${stateKey}:open`, false);
  const [failed, setFailed] = useState<string>();
  if (!sources.length && !pending) return null;
  return <TraceCollapsible open={open} onOpenChange={setOpen} data-conversation-sources="true">
    <TraceCollapsibleTrigger>
      <TraceLine {...(pending ? { status: "running" as const } : {})}>
        <TraceIcon>{pending ? <LoaderCircle className="animate-spin" /> : <Globe />}</TraceIcon>
        <TraceTitle>{pending ? "正在同步检索来源" : `检索到 ${sources.length} 个来源`}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent>
      <Trace>{sources.map(source => <ConversationHoverCard key={source.url} kind="source" label={source.title} trigger={<a href={source.url} onClick={async event => {
        event.preventDefault();
        try { await window.harness.openExternal(source.url); setFailed(undefined); }
        catch { setFailed(source.url); }
      }}>
        <TraceLine>
          <TraceIcon><Globe /></TraceIcon>
          <TraceTitle>{source.title}<span className="sr-only">（在浏览器中打开）</span></TraceTitle>
          <TraceIcon><ArrowUpRight /></TraceIcon>
        </TraceLine>
      </a>}>
        {() => <p className="conversation-hover-code">{source.url}</p>}
      </ConversationHoverCard>)}</Trace>
      {pending && <p role="status">正在同步工具输出，来源列表尚未完整。</p>}
      {failed && <p role="status">链接打开失败，请重试。</p>}
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

export function ThinkingTraceRow({ id, running, active, paused = false }: { id: string; running: boolean; active: boolean; paused?: boolean }) {
  const [open, setOpen] = useRowState(`thinking:${id}:open`, false);
  return <TraceCollapsible open={open} onOpenChange={setOpen} data-conversation-reasoning="true" data-summary-available="false">
    <TraceCollapsibleTrigger>
      <TraceLine {...(running ? { status: "running" as const } : {})}>
        <TraceIcon>{running ? <LoaderCircle className="animate-spin" /> : <Brain />}</TraceIcon>
        <TraceTitle>{running ? "正在思考" : "思考摘要"}</TraceTitle>
        {!running && <TraceDescription>{active ? "等待摘要" : paused ? "已暂停" : "未返回摘要"}</TraceDescription>}
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent><p className="conversation-thinking-placeholder">{active || paused ? "模型尚未返回可展示的思考摘要。过程对话和工具执行会继续在下方显示。" : "本轮模型未提供可展示的思考摘要。已返回的过程对话和工具记录保留在下方。"}</p></TraceCollapsibleContent>
  </TraceCollapsible>;
}
