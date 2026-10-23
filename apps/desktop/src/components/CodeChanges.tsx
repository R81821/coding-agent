import React, { useMemo, useState } from "react";
import type { AgentEvent } from "@harness/protocol";
import { changeSnapshots, type ChangeSnapshot, type DiffLine } from "../code-changes.js";
function splitRows(lines: DiffLine[]): [DiffLine | undefined, DiffLine | undefined][] {
 const rows: [DiffLine | undefined, DiffLine | undefined][] = [];
 for (let i=0;i<lines.length;) {
  const line=lines[i]!;
  if (line.kind === "delete" || line.kind === "add") {
   const removed: DiffLine[] = [], added: DiffLine[] = [];
   while (lines[i]?.kind === "delete") removed.push(lines[i++]!);
   while (lines[i]?.kind === "add") added.push(lines[i++]!);
   for(let j=0;j<Math.max(removed.length,added.length);j++) rows.push([removed[j],added[j]]);
  } else { rows.push([line,line]); i++; }
 }
 return rows;
}
export function CodeChanges({ events, includeGitDiff = true, snapshots: provided, compact = false }: { events: AgentEvent[]; includeGitDiff?: boolean; snapshots?: ChangeSnapshot[]; compact?: boolean }) {
 const snapshots = useMemo(()=>provided ?? changeSnapshots(events,includeGitDiff),[provided,events,includeGitDiff]);
 const [snapshotId,setSnapshotId]=useState("");
 const [path,setPath]=useState("");
 const [mode,setMode]=useState("unified");
 const snapshot=snapshots.find(item=>item.id===snapshotId) ?? snapshots[0];
 const file=snapshot?.files.find(item=>item.path===path) ?? snapshot?.files[0];
 return <div className={compact ? "code-changes code-changes-compact" : "code-changes"}>
  {!compact && <header><h2>代码变更</h2><p>显示当前会话记录的已应用补丁和 Git 差异快照。每次记录独立查看，不代表磁盘当前状态。</p></header>}
  {!snapshots.length ? <div className="glass p-6">暂无差异记录。执行补丁修改或 git_diff 后将在这里显示；终端修改需后续 Git 差异记录。</div> : <>
   <div className="changes-toolbar">{!compact && <label>变更记录 <select aria-label="变更记录" value={snapshot?.id ?? ""} onChange={event=>{setSnapshotId(event.target.value);setPath("");}}>{snapshots.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}<div role="group" aria-label="差异显示方式"><button aria-pressed={mode==="unified"} onClick={()=>setMode("unified")}>统一视图</button><button aria-pressed={mode==="split"} onClick={()=>setMode("split")}>并排视图</button></div></div>
   <div className="changes-layout"><nav aria-label="变更文件">{snapshot?.files.map((item,index)=><button key={`${item.path}:${index}`} aria-current={file===item ? "true" : undefined} onClick={()=>setPath(item.path)}><span>{item.path}</span><small>{item.countsComplete === false ? "统计未完整" : <><b className="diff-plus">+{item.added}</b><b className="diff-minus">−{item.deleted}</b></>}</small></button>)}</nav>
   <section className="diff-document" aria-label="代码差异"><h3>{file?.path ?? "没有可显示的文件"}</h3><div className="diff-scroll" tabIndex={0}>
    {file && mode==="unified" && <table className="diff-table"><thead><tr><th>旧行</th><th>新行</th><th>差异</th></tr></thead><tbody>{file.lines.map((line,index)=><tr key={index} className={`diff-${line.kind}`}><td>{line.oldLine}</td><td>{line.newLine}</td><td><pre><span>{line.kind==="add"?"+":line.kind==="delete"?"−":" "}</span>{line.text}</pre></td></tr>)}</tbody></table>}
    {file && mode==="split" && <table className="diff-table diff-split"><thead><tr><th colSpan={2}>修改前</th><th colSpan={2}>修改后</th></tr></thead><tbody>{splitRows(file.lines).map(([left,right],index)=><tr key={index}><td className={`diff-${left?.kind ?? "empty"}`}>{left?.oldLine}</td><td className={`diff-${left?.kind ?? "empty"}`}><pre>{left?.text ?? " "}</pre></td><td className={`diff-${right?.kind ?? "empty"}`}>{right?.newLine}</td><td className={`diff-${right?.kind ?? "empty"}`}><pre>{right?.text ?? " "}</pre></td></tr>)}</tbody></table>}
   </div></section></div>
  </>}
 </div>;
}
