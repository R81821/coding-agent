// Run after pnpm build: node apps/daemon/scripts/isolation-smoke.cjs
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const path=require("node:path");
const net=require("node:net");
const {randomUUID}=require("node:crypto");
const root=path.resolve(__dirname,"../../..");
const fixture=fs.mkdtempSync(path.join(root,".cache/daemon-isolation-"));
const children=[];
const endpoints=[];
function health(endpoint){return new Promise((resolve,reject)=>{
  const socket=net.connect(endpoint);let buffer="";
  socket.setTimeout(1000,()=>socket.destroy(new Error("health timeout")));
  socket.on("error",reject);
  socket.on("connect",()=>socket.write(JSON.stringify({id:"fixture-health",method:"health"})+"\n"));
  socket.on("data",chunk=>{buffer+=chunk;if(buffer.includes("\n")){socket.end();resolve(JSON.parse(buffer.split("\n")[0]));}});
});}
async function start(configured){
  const id=`test_${randomUUID()}`;
  const data=path.join(fixture,id);fs.mkdirSync(data);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(OPENAI|ANTHROPIC|GEMINI|HARNESS|PARALLEL|ELECTRON_RUN_AS_NODE)/i.test(key)));
  Object.assign(env,{HARNESS_APP_DATA_PATH:data,HARNESS_DAEMON_INSTANCE:id});
  if(configured)Object.assign(env,{OPENAI_COMPATIBLE_BASE_URL:"http://127.0.0.1:9/v1",OPENAI_COMPATIBLE_MODEL:"fixture-model"});
  const endpoint=process.platform==="win32"?`\\\\.\\pipe\\harness-agent-v2-${id}`:path.join(require("node:os").tmpdir(),`harness-agent-v2-${id}.sock`);
  endpoints.push(endpoint);
  const child=spawn(process.execPath,[path.join(root,"apps/daemon/dist/main.js")],{cwd:data,env,windowsHide:true,stdio:["pipe","ignore","pipe"]});children.push(child);
  let error="";child.stderr.on("data",chunk=>{error=(error+chunk).slice(-3000)});
  child.stdin.end("fixture-password-only\n");
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`Daemon exited: ${error}`);
    try{const response=await health(endpoint);if(!response.ok)throw new Error("health rejected");return response.result;}catch{await new Promise(resolve=>setTimeout(resolve,150));}
  }
  throw new Error(`Daemon did not start: ${error}`);
}
(async()=>{try{
  const empty=await start(false);
  const configured=await start(true);
  if(JSON.stringify(empty.providerIds)!=="[]")throw new Error("Empty daemon loaded unexpected providers");
  if(JSON.stringify(configured.providerIds)!=='["openai-compatible"]')throw new Error("Configured daemon did not load its provider");
  const again=await health(endpoints[0]);
  if(again.result.providerIds.length!==0)throw new Error("Daemon instances mixed configurations");
  console.log(JSON.stringify({version:configured.version,isolatedDaemons:2,emptyProviders:empty.providerIds,configuredProviders:configured.providerIds,modelRequests:0}));
}finally{await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once("exit",resolve);child.kill();})));}})().catch(error=>{console.error(error);process.exitCode=1});