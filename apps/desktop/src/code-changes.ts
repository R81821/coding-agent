import type { AgentEvent } from "@harness/protocol";
export interface DiffLine { kind: "add" | "delete" | "context" | "meta"; text: string; oldLine?: number; newLine?: number }
export interface DiffFile { path: string; added: number; deleted: number; lines: DiffLine[]; byteLength?: number; countsComplete?: boolean; truncated?: boolean }
export interface ChangeSnapshot { id: string; label: string; files: DiffFile[] }
export interface AppliedToolChanges { kind: "write" | "edit"; files: DiffFile[]; diffText: string; unchanged: boolean }
export function isLocalFileEdit(started: Extract<AgentEvent, {type: "tool_started"}>): boolean {
 return !started.origin && ["write_file", "patch", "apply_patch"].includes(started.call.name);
}
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
 if (raw.length > 12000 && file) { file.lines.push({kind:"meta",text:"预览已截断：仅展示前 12000 行，统计仅含已展示内容。"}); file.truncated = true; file.countsComplete = false; }
 return files;
}
/** Display only successful local edit receipts, never an attempted command or remote tool name. */
export function appliedToolChanges(started: Extract<AgentEvent, {type: "tool_started"}>, finished?: Extract<AgentEvent, {type: "tool_finished"}>): AppliedToolChanges | undefined {
 if (!isLocalFileEdit(started) || !finished || finished.isError) return;
 // run.output hydrates saved receipts as JSON text; live events carry the same receipt as an object.
 let value: unknown = finished.output;
 if (typeof value === "string") { try { value = JSON.parse(value); } catch { return; } }
 if (!value || typeof value !== "object" || Array.isArray(value)) return;
 const output = value as Record<string, unknown>;
 const write = started.call.name === "write_file";
 if (write ? output.written !== true : output.applied !== true) return;
 const finiteCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
 const paths = write ? typeof output.path === "string" ? [output.path] : [] : Array.isArray(output.paths) ? output.paths.filter((path): path is string => typeof path === "string") : [];
 const normalizedMissing = !write && output.normalizedHunkCounts === true && typeof output.diff !== "string";
 const unchanged = write && output.changed === false;
 const raw = unchanged ? "" : typeof output.diff === "string" ? output.diff : !write && !normalizedMissing && typeof started.call.input.patch === "string" ? started.call.input.patch : "";
 const truncated = output.diffTruncated === true || raw.length > 200_000 || normalizedMissing;
 const files = parseDiff(raw.slice(0, 200_000));
 if (write && files.length === 1 && paths[0]) files[0]!.path = paths[0];
 const previewIncomplete = truncated || files.some(file => file.truncated);
 if (!files.length || previewIncomplete) for (const path of paths) {
  if (files.some(file => file.path === path)) continue;
  files.push({ path, added: 0, deleted: 0, countsComplete: unchanged && !previewIncomplete, ...(previewIncomplete ? { truncated: true } : {}), lines: [{ kind: "meta", text: normalizedMissing ? "旧记录缺少规范化后的差异，无法完整预览。" : previewIncomplete ? "差异超过预览预算，无法完整展示。" : unchanged ? "文件内容未发生变化。" : "此记录没有可显示的文本差异。" }] });
 }
 for (const file of files) {
  if (truncated || file.truncated) { file.truncated = true; file.countsComplete = false; }
  if (write) {
   if (finiteCount(output.byteLength)) file.byteLength = output.byteLength;
   if (unchanged) { file.added = 0; file.deleted = 0; file.countsComplete = true; }
   else if (finiteCount(output.added) && finiteCount(output.deleted)) { file.added = output.added; file.deleted = output.deleted; file.countsComplete = true; }
  }
 }
 if (!files.length) return;
 return { kind: write ? "write" : "edit", files, diffText: raw.slice(0, 200_000), unchanged };
}
export function changeSnapshots(events: AgentEvent[], includeGitDiff = true): ChangeSnapshot[] {
 const calls = new Map<string, Extract<AgentEvent,{type:"tool_started"}>>();
 const snapshots: ChangeSnapshot[] = [];
 for (const event of events) {
  if (event.type === "tool_started") calls.set(`${event.runId}:${event.call.id}`,event);
  if (event.type !== "tool_finished" || event.isError) continue;
  const started = calls.get(`${event.runId}:${event.callId}`);
  if (!started) continue;
  const call = started.call;
  const output = event.output && typeof event.output === "object" ? event.output as Record<string,unknown> : {};
  const time = new Date(event.at).toLocaleString();
  const applied = appliedToolChanges(started, event);
  if (applied) snapshots.push({id:event.id,label:`${time} · ${applied.kind === "write" ? "已写入文件" : "已应用补丁"}`,files:applied.files});
  if (call.name === "git_diff" && includeGitDiff) {
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
