import React, { useMemo } from "react";
import { useRowState } from "@harness/conversation-ui";
import { isDeferredOutput } from "@harness/protocol";
import { CircleAlert, CircleCheck, CirclePause, FilePenLine, LoaderCircle } from "lucide-react";
import { appliedToolChanges, type AppliedToolChanges, type DiffFile } from "../code-changes.js";
import { getToolTraceState } from "../conversation-trace.js";
import type { ToolTimelineItem } from "../conversation-stream.js";
import { toolSummary } from "../tool-summary.js";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "../ui/code-block.js";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../ui/trace.js";
import "./file-edit-trace.css";

function language(path: string): string {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  return (({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", sh: "shell", ps1: "powershell", yml: "yaml", md: "markdown" } as Record<string, string>)[extension] ?? extension) || "text";
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

function Counts({ files, unchanged }: { files: DiffFile[]; unchanged: boolean }) {
  if (unchanged) return <span className="tool-edit-meta">内容未变</span>;
  if (files.some(file => file.countsComplete === false)) return <span className="tool-edit-meta">统计未完整</span>;
  return <span className="tool-edit-counts"><span className="tool-edit-count-add">+{files.reduce((sum, file) => sum + file.added, 0)}</span><span className="tool-edit-count-delete">−{files.reduce((sum, file) => sum + file.deleted, 0)}</span></span>;
}

export function ToolEditPanel({ changes }: { changes: AppliedToolChanges }) {
  return <div className="tool-edit-panels">{changes.files.map((file, fileIndex) => <CodeBlock key={`${file.path}:${fileIndex}`} className="tool-edit-panel" data-path={file.path}>
    <CodeBlockHeader><CodeBlockTitle>{language(file.path)}</CodeBlockTitle><CodeBlockActions>{changes.diffText && <CodeBlockCopyButton value={changes.diffText} aria-label="复制差异" title="复制本次工具调用的差异" />}</CodeBlockActions></CodeBlockHeader>
    <div className="tool-edit-path" title={file.path}>{file.path}</div>
    {file.truncated && <p className="tool-edit-preview-note" role="status">预览已截断{file.countsComplete === false ? "，无法提供完整增删统计" : "，统计来自实际写入回执"}。</p>}
    <CodeBlockContent className="tool-edit-scroll" aria-label={`${file.path} 代码差异`}>
      {file.lines.map((line, index) => <CodeBlockLine key={index} className={`tool-edit-line-${line.kind}`} variant={line.kind === "add" ? "added" : line.kind === "delete" ? "removed" : "default"}>
        <span className="tool-edit-line-prefix" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}</span>{line.text}
      </CodeBlockLine>)}
    </CodeBlockContent>
  </CodeBlock>)}</div>;
}

export function FileEditTraceRow({ tool, active }: { tool: ToolTimelineItem; active: boolean }) {
  const { started, finished } = tool;
  const [storedOpen, setOpen] = useRowState<boolean | undefined>(`tool:${started.id}:open`, undefined);
  const [rawOpen, setRawOpen] = useRowState(`tool:${started.id}:raw`, false);
  const changes = useMemo(() => appliedToolChanges(started, finished), [started, finished]);
  const state = getToolTraceState(started, finished, active);
  const deferred = finished && isDeferredOutput(finished.output);
  const open = storedOpen ?? Boolean(changes);
  const writing = started.call.name === "write_file";
  const verb = writing ? "写入" : "编辑";
  const label = state === "running" ? `正在${verb}` : state === "error" ? `${verb}失败` : state === "interrupted" ? `${verb}已中断` : deferred ? `正在同步${verb}记录` : changes ? verb : `${verb}记录`;
  const summary = toolSummary(started.call.name, started.call.input);
  const paths = changes?.files.map(file => file.path) ?? [];
  const pathLabel = paths.length ? paths.slice(0, 2).join(", ") + (paths.length > 2 ? ` 等 ${paths.length} 个文件` : "") : summary.detail || summary.label;
  const byteLength = changes?.files.length === 1 ? changes.files[0]!.byteLength : undefined;
  const Icon = state === "error" ? CircleAlert : state === "interrupted" ? CirclePause : state === "running" || deferred ? LoaderCircle : changes ? CircleCheck : FilePenLine;
  return <TraceCollapsible open={open} onOpenChange={setOpen} className="conversation-file-edit-row" data-tool-call-id={started.call.id} data-tool-name={started.call.name} data-tool-state={state}>
    <TraceCollapsibleTrigger className="conversation-file-edit-trigger"><TraceLine {...(state === "running" || state === "error" ? { status: state } : {})}>
      <TraceIcon><Icon className={state === "running" || deferred ? "animate-spin" : undefined} /></TraceIcon>
      <TraceTitle>{label} · <span className="tool-edit-title-path" title={pathLabel}>{pathLabel}</span></TraceTitle>
      {byteLength !== undefined && <TraceDescription>{sizeLabel(byteLength)}</TraceDescription>}
      {changes && <Counts files={changes.files} unchanged={changes.unchanged} />}
    </TraceLine></TraceCollapsibleTrigger>
    <TraceCollapsibleContent>{open && <div className="conversation-file-edit-content">
      {changes ? <ToolEditPanel changes={changes} /> : <p role="status">{deferred ? "正在同步写入记录…" : state === "running" ? "等待写入结果…" : state === "error" ? "文件写入未成功，未生成代码变更回执。" : state === "interrupted" ? "操作已中断，没有可确认的代码变更回执。" : "此记录没有可确认的代码变更回执。"}</p>}
      <button type="button" className="tool-edit-raw-toggle" aria-expanded={rawOpen} onClick={() => setRawOpen(value => !value)}>{rawOpen ? "收起参数和回执" : "查看参数和回执"}</button>
      {rawOpen && <><CodeBlock size="sm"><CodeBlockContent wrap>{JSON.stringify(started.call.input, null, 2)}</CodeBlockContent></CodeBlock>{finished && !deferred && <CodeBlock size="sm"><CodeBlockContent wrap>{typeof finished.output === "string" ? finished.output : JSON.stringify(finished.output, null, 2)}</CodeBlockContent></CodeBlock>}</>}
    </div>}</TraceCollapsibleContent>
  </TraceCollapsible>;
}
