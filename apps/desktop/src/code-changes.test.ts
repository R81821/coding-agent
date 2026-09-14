import { describe, expect, it } from "vitest";
import { parseDiff, changeSnapshots } from "./code-changes.js";
import { approvalFields } from "./approval-content.js";
import type { AgentEvent } from "@harness/protocol";
const patch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n';
describe("code changes", () => {
 it("counts edits and tracks old/new line numbers", () => {
  const file = parseDiff(patch)[0]!;
  expect(file.path).toBe("src/a.ts"); expect(file.added).toBe(2); expect(file.deleted).toBe(1);
  expect(file.lines.filter(line => line.kind === "add").map(line => line.newLine)).toEqual([3,4]);
  expect(file.lines.find(line => line.kind === "delete")?.oldLine).toBe(3);
 });
 it("retains binary metadata and decodes Git quoted UTF-8 paths", () => {
  expect(parseDiff('diff --git a/a b/a\nBinary files a/a and b/a differ')[0]?.lines[0]?.text).toContain("Binary");
  expect(parseDiff('--- "a/\\344\\270\\255.txt"\n+++ "b/\\344\\270\\255.txt"\n@@ -1 +1 @@\n-a\n+b')[0]?.path).toBe("中.txt");
 });
 it("does not treat pending or failed patches as applied", () => {
  const start = {type:"tool_started",id:"s",runId:"r",at:"2026-09-13T00:00:00Z",sequence:0,call:{id:"c",name:"patch",input:{patch}}} as AgentEvent;
  const finish = {type:"tool_finished",id:"f",runId:"r",at:start.at,sequence:1,callId:"c",output:{applied:true},durationMs:1} as Extract<AgentEvent,{type:"tool_finished"}>;
  expect(changeSnapshots([start])).toHaveLength(0);
  expect(changeSnapshots([start,{...finish,isError:true}])).toHaveLength(0);
  expect(changeSnapshots([start,finish])[0]?.files[0]?.added).toBe(2);
 });
});
describe("approval content", () => {
 it("extracts content with real newlines and preserves code braces and other parameters", () => {
  expect(approvalFields({content:'if (ok) {\n  run();\n}',path:'src/a.ts',timeoutMs:0})).toEqual([
   {label:'正文',text:'if (ok) {\n  run();\n}'},{label:'path',text:'src/a.ts'},{label:'timeoutMs',text:'0'}
  ]);
 });
 it("unwraps serialized content objects but preserves ordinary command strings", () => {
  expect(approvalFields('{"content":"echo hello\\nnext"}')).toEqual([{label:'正文',text:'echo hello\nnext'}]);
  expect(approvalFields({command:'echo "{}"',stdin:'{"ok":true}'})).toEqual([{label:'命令',text:'echo "{}"'},{label:'标准输入',text:'{"ok":true}'}]);
 });
});
it("parses header-only multi-file patches and deleted paths containing spaces",()=>{
 const files=parseDiff('--- a/old name.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n--- /dev/null\n+++ b/new name.txt\n@@ -0,0 +1 @@\n+created\n');
 expect(files.map(file=>[file.path,file.added,file.deleted])).toEqual([['old name.txt',0,1],['new name.txt',1,0]]);
});
it("keeps staged, unstaged and untracked snapshots separate and marks omitted content",()=>{
 const base={runId:'r',at:'2026-09-13T00:00:00Z',sequence:0};
 const events: AgentEvent[]=[{...base,id:'s',type:'tool_started',call:{id:'git',name:'git_diff',input:{}}},{...base,id:'f',sequence:1,type:'tool_finished',callId:'git',durationMs:1,output:{diff:patch,stagedDiff:patch,newFiles:[{path:'new.txt',content:'hello\n'},{path:'image.png',content:'Not fully inspected: binary or size limit'}]}}];
 const snapshots=changeSnapshots(events);
 expect(snapshots).toHaveLength(3);
 expect(snapshots[0]?.files.map(file=>file.added)).toEqual([1,0]);
 expect(snapshots[0]?.files[1]?.lines[0]?.kind).toBe('meta');
 expect(new Set(snapshots.map(snapshot=>snapshot.id)).size).toBe(3);
});
it("preserves a metadata-only rename and reports bounded previews",()=>{
 expect(parseDiff('diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts')[0]?.path).toBe('new.ts');
 const file=parseDiff('--- a/a\n+++ b/a\n@@ -0,0 +1,13000 @@\n'+'+x\n'.repeat(13000))[0]!;
 expect(file.lines.at(-1)?.text).toContain('预览已截断');
 expect(file.added).toBeLessThan(13000);
});
