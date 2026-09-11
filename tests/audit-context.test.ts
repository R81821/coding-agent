import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReadEvidenceCache } from "../packages/core/src/read-evidence-cache.js";
import { LightweightWorkflow } from "../packages/core/src/lightweight-workflow.js";
import { isolatedProbeInvocation } from "../packages/core/src/isolated-probe.js";
it("reuses original evidence only while actual content is unchanged", async () => {
 const root=await mkdtemp(join(tmpdir(),"evidence-cache-"));
 try { const path=join(root,"a.ts"); await writeFile(path,"one"); const time=await stat(path);
 const cache=new ReadEvidenceCache(), call={id:"first",name:"read_file",input:{path:"a.ts"}};
 cache.remember(await cache.identify(call,root),call.id,{output:"one"});
 expect(cache.lookup(await cache.identify(call,root))?.output).toMatchObject({reusedEvidenceId:"first"});
 await writeFile(path,"two"); await utimes(path,time.atime,time.mtime);
 expect(cache.lookup(await cache.identify(call,root))).toBeUndefined();
 } finally {await rm(root,{recursive:true,force:true,maxRetries:10});}
});
it("keeps projected state bounded for maximum-length todos and paths",()=>{
 const workflow=new LightweightWorkflow("goal".repeat(1500),()=>{});
 workflow.state.todos=Array.from({length:20},(_,i)=>({id:String(i),text:"内容".repeat(150),status:"pending" as const}));
 workflow.state.changedFiles=Array.from({length:40},(_,i)=>String(i)+"path/".repeat(300));
 expect(JSON.stringify(workflow.projection()).length).toBeLessThanOrEqual(8192);
});
it("isolated analysis probe has a read-only root and repository with no network",()=>{
 const args=isolatedProbeInvocation("D:/repo","D:/scratch","echo test > /workspace/a.ts","node:22","probe-test");
 expect(args).toContain("--read-only"); expect(args).toContain("--network=none");
 expect(args).toContain("type=bind,source=D:/repo,target=/workspace,readonly");
 expect(args).toContain("--pull=never"); expect(args).toContain("--cap-drop=ALL");
 expect(args.slice(-3)).toEqual(["/bin/sh","-c","echo test > /workspace/a.ts"]);
});
