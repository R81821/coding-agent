import type { AgentEvent } from "@harness/protocol";
export interface DiffLine { kind: "add" | "delete" | "context" | "meta"; text: string; oldLine?: number; newLine?: number }
export interface DiffFile { path: string; added: number; deleted: number; lines: DiffLine[] }
export interface ChangeSnapshot { id: string; label: string; files: DiffFile[] }
function gitPath(raw: string): string {
 let path = raw.trim();
 if (path.startsWith('"') && path.endsWith('"')) {
  path = path.slice(1, -1).replace(/(?:\\[0-7]{3})+/g, encoded => new TextDecoder().decode(Uint8Array.from(encoded.match(/[0-7]{3}/g)!.map(oct => parseInt(oct,8))))).replace(/\\([\\"tnr])/g, (_, char: string) => ({t:'\t',n:'\n',r:'\r'}[char] ?? char));
 }
 return path.replace(/^[ab]\//, "");
}
export function parseDiff(diff: string): DiffFile[] {
 const files: DiffFile[] = [];
 let file: DiffFile | undefined;
 let oldLine = 0, newLine = 0, inHunk = false, oldRemaining = 0, newRemaining = 0;
 let awaitingOldHeader = false;
 const create = (path: string) => { file = {path,added:0,deleted:0,lines:[]}; files.push(file); inHunk = false; awaitingOldHeader = true; };
 // Bound DOM work for unusually large recorded output; retain an explicit marker.
 const raw = diff.split("\n");
 for (const source of raw.slice(0, 12000)) {
  const line = source.replace(/\r$/, "");
  if (line.startsWith("diff --git ")) {
   const paths = line.slice(11).match(/"(?:\\.|[^"\\])*"|\S+/g);
   create(gitPath(paths?.at(-1) ?? "未知文件")); continue;
  }
  if (!inHunk && line.startsWith("--- ")) {
   if (!file || !awaitingOldHeader) create(gitPath(line.slice(4)));
   if (file && line.slice(4) !== "/dev/null") file.path=gitPath(line.slice(4));
   awaitingOldHeader=false; continue;
  }
  if (!inHunk && line.startsWith("+++ ")) { if (!file) create(gitPath(line.slice(4))); else if (line.slice(4) !== "/dev/null") file.path = gitPath(line.slice(4)); continue; }
  if (!file) continue;
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (hunk) { oldLine=Number(hunk[1]); newLine=Number(hunk[3]); oldRemaining=Number(hunk[2] ?? 1); newRemaining=Number(hunk[4] ?? 1); inHunk=oldRemaining > 0 || newRemaining > 0; file.lines.push({kind:"meta",text:line}); continue; }
  if (inHunk && line.startsWith("+")) { newRemaining--; file.added++; file.lines.push({kind:"add",text:line.slice(1),newLine:newLine++}); }
  else if (inHunk && line.startsWith("-")) { oldRemaining--; file.deleted++; file.lines.push({kind:"delete",text:line.slice(1),oldLine:oldLine++}); }
  else if (inHunk && line.startsWith(" ")) { oldRemaining--; newRemaining--; file.lines.push({kind:"context",text:line.slice(1),oldLine:oldLine++,newLine:newLine++}); }
  else if (line) file.lines.push({kind:"meta",text:line});
  if (oldRemaining <= 0 && newRemaining <= 0) inHunk=false;
 }
 if (raw.length > 12000 && file) file.lines.push({kind:"meta",text:"预览已截断：仅展示前 12000 行，统计仅含已展示内容。"});
 return files;
}
export function changeSnapshots(events: AgentEvent[]): ChangeSnapshot[] {
 const calls = new Map<string, Extract<AgentEvent,{type:"tool_started"}>["call"]>();
 const snapshots: ChangeSnapshot[] = [];
 for (const event of events) {
  if (event.type === "tool_started") calls.set(`${event.runId}:${event.call.id}`,event.call);
  if (event.type !== "tool_finished" || event.isError) continue;
  const call = calls.get(`${event.runId}:${event.callId}`);
  if (!call) continue;
  const output = event.output && typeof event.output === "object" ? event.output as Record<string,unknown> : {};
  const time = new Date(event.at).toLocaleString();
  if (["patch","apply_patch"].includes(call.name) && output.applied === true && typeof call.input.patch === "string") {
   snapshots.push({id:event.id,label:`${time} · 已应用补丁`,files:parseDiff(call.input.patch)});
  }
  if (call.name === "git_diff") {
   for (const [key,label] of [["diff","未暂存"],["stagedDiff","已暂存"]] as const) {
    if (typeof output[key] === "string" && output[key]) snapshots.push({id:`${event.id}:${key}`,label:`${time} · Git 快照 · ${label}`,files:parseDiff(output[key])});
   }
   if (Array.isArray(output.newFiles) && output.newFiles.length) {
    const files: DiffFile[] = output.newFiles.flatMap((item: unknown) => {
     if (!item || typeof item !== "object" || !("path" in item) || !("content" in item) || typeof item.path !== "string" || typeof item.content !== "string") return [];
     const omitted = item.content.startsWith("Not fully inspected:");
     const lines: DiffLine[] = omitted ? [{kind:"meta",text:item.content}] : (item.content ? item.content.replace(/\n$/,"").split("\n").slice(0,12000).map((text,index)=>({kind:"add",text,newLine:index+1})) : []);
     if (!omitted && item.content.split("\n").length > 12001) lines.push({kind:"meta",text:"预览已截断：仅展示前 12000 行。"});
     return [{path:item.path,added:omitted ? 0 : lines.filter(line=>line.kind==="add").length,deleted:0,lines}];
    });
    snapshots.push({id:`${event.id}:new`,label:`${time} · Git 快照 · 未跟踪文件`,files});
   }
  }
 }
 return snapshots.reverse();
}
