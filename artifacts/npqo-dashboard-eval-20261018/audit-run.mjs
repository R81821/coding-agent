import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = String.raw`D:\qweai\artifacts\npqo-dashboard-eval-20261018`;
const pipe = String.raw`\\.\pipe\harness-agent-v2-desktop_302621c0-de5f-4f6b-860b-b60d6ac25ac8`;
const sessionId = 'session_e7761fe9-98ec-4663-bc51-aace34762593';
const runId = 'run_a566d631-77eb-418e-ac99-c252a35395ef';
const allowed = new Set(['run.get', 'run.eventPage', 'run.output']);
const intervalMs = 45000;
const stamp = () => new Date().toISOString();
const clean = value => typeof value === 'string' ? value
  .replace(/Bearer\s+[A-Za-z0-9._~-]{16,}/g, 'Bearer [REDACTED]')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
  .replace(/("?(?:api[_-]?key|access[_-]?token|password|passphrase|secret)"?\s*[:=]\s*)"[^"\r\n]+"/gi, '$1"[REDACTED]"')
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(?:api[_-]?key|access[_-]?token|password|passphrase|secret)$/i.test(k) ? '[REDACTED]' : clean(v)])) : value;

function query(method, params) {
  if (!allowed.has(method)) throw new Error('Read-only RPC allowlist rejected ' + method);
  if (params?.runId !== runId) throw new Error('Wrong run rejected');
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('RPC timeout: ' + method)); }, 15000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({id:'audit-' + Date.now(), method, params}) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(buffer.slice(0,newline)); response.ok ? resolve(response.result) : reject(new Error(response.error?.message ?? 'RPC failed')); }
      catch(error) { reject(error); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

await fs.mkdir(path.join(root, 'tool-outputs'), {recursive:true});
const run = await query('run.get', {runId});
if (run.spec?.sessionId !== sessionId || run.spec?.workspacePath?.toLowerCase() !== String.raw`D:\npqo`.toLowerCase()) throw new Error('Session/workspace mismatch');
const recordedRun = { ...run, spec: { ...run.spec, attachments: run.spec.attachments.map(attachment => ({fileName:attachment.fileName,mimeType:attachment.mimeType,width:attachment.width ?? null,height:attachment.height ?? null,trust:attachment.trust})) } };
await fs.writeFile(path.join(root,'run-start.json'), JSON.stringify(clean(recordedRun),null,2));
await fs.writeFile(path.join(root,'original-prompt.txt'), run.spec.request + '\n');
await fs.writeFile(path.join(root,'baseline.json'), JSON.stringify({
  auditStartedAt:stamp(), runId, sessionId, workspacePath:String.raw`D:\npqo`,
  baselineObservedAt:null, baselineTimeNote:'Observed before run start; exact observation timestamp was not recorded',
  baselineSource:'Pre-submission read-only directory inventory by evaluator',
  baselineFiles:['AGENTS.md'], baselineGitRepository:false, baselinePackageJson:false,
  referenceImage:String.raw`C:\Users\13437\OneDrive\Desktop\PixPin_2026-10-14_21-58-13.png`,
  auditScope:'Only this run; named-pipe read-only RPC; no database reads, no target code writes, no builds or repairs by evaluator',
  pollIntervalMs:intervalMs, outputRedaction:'Common credential patterns are redacted before storage',
},null,2));

let afterSequence = -1;
let events = [];
let seenOutputs = new Set();
try {
  const saved=JSON.parse(await fs.readFile(path.join(root,'audit-state.json'),'utf8'));
  afterSequence=saved.afterSequence ?? -1;
  events=(await fs.readFile(path.join(root,'run-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  seenOutputs=new Set(saved.savedOutputs ?? []);
} catch { /* The first capture has no saved audit state. */ }

async function captureOutput(event) {
  if(seenOutputs.has(event.callId)) return;
  const call=events.find(e=>e.type==='tool_started' && e.call?.id===event.callId)?.call;
  let offset=0, text='', hasMore=true, pageCount=0;
  while(hasMore && pageCount<32) {
    const page=await query('run.output',{runId,callId:event.callId,offset,limit:16000});
    text+=page.text; offset=page.nextOffset; hasMore=page.hasMore; pageCount++;
  }
  const result=clean({capturedAt:stamp(),callId:event.callId,tool:call?.name,input:call?.input,isError:event.isError===true,durationMs:event.durationMs,text,truncated:hasMore});
  await fs.writeFile(path.join(root,'tool-outputs',event.callId.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json'),JSON.stringify(result,null,2));
  seenOutputs.add(event.callId);
}

async function poll() {
  let page;
  do {
    page=await query('run.eventPage',{runId,afterSequence,limit:200});
    const fresh=clean(page.events ?? []);
    if(fresh.length) { await fs.appendFile(path.join(root,'run-events.jsonl'),fresh.map(event=>JSON.stringify(event)).join('\n')+'\n'); events.push(...fresh); }
    afterSequence=page.nextSequence;
  } while(page.hasMore);
  for(const event of events.filter(e=>e.type==='tool_finished')) {
    try { await captureOutput(event); }
    catch(error) { await fs.appendFile(path.join(root,'audit-errors.jsonl'),JSON.stringify({at:stamp(),callId:event.callId,error:String(error)})+'\n'); }
  }
  const freshResult=events.filter(e=>e.type==='result').at(-1);
  const approval=events.filter(e=>['approval_required','plan_approval_required'].includes(e.type)).at(-1);
  const latestStatusEvent=events.filter(e=>e.type==='status').at(-1);
  const summary=clean({
    capturedAt:stamp(),runId,sessionId,status:page.status,afterSequence,eventCount:events.length,
    startedAt:run.spec.createdAt,models:events.filter(e=>e.type==='route').map(e=>({at:e.at,providerId:e.providerId,modelId:e.modelId,reason:e.reason})),
    usage:events.filter(e=>e.type==='usage'),
    tools:events.filter(e=>e.type==='tool_started').map(e=>({at:e.at,sequence:e.sequence,...e.call})),
    toolErrors:events.filter(e=>e.type==='tool_finished' && e.isError),
    failures:events.filter(e=>['error','budget_exceeded','provider_retry'].includes(e.type)),
    latestStatusEvent,pendingApproval:page.status==='waiting_approval'?approval:null,
    result:freshResult ?? null,savedOutputs:[...seenOutputs],
  });
  await fs.writeFile(path.join(root,'audit-summary.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(root,'audit-state.json'),JSON.stringify({afterSequence,savedOutputs:[...seenOutputs]},null,2));
  if(freshResult) {
    await fs.writeFile(path.join(root,'agent-final-result.json'),JSON.stringify(freshResult,null,2));
    const deltas=events.filter(e=>e.type==='text_delta').map(e=>e.delta).join('');
    await fs.writeFile(path.join(root,'agent-text-transcript.txt'),deltas);
  }
  console.log(JSON.stringify({at:stamp(),status:page.status,events:events.length,sequence:afterSequence,toolCount:summary.tools.length,toolErrors:summary.toolErrors.length,models:summary.models.map(m=>m.modelId),pendingApproval:summary.pendingApproval,result:freshResult ?? null}));
  return ['completed','failed','cancelled','paused'].includes(page.status) || Boolean(freshResult);
}

for(;;) {
  try { if(await poll()) break; }
  catch(error) { console.log(JSON.stringify({at:stamp(),auditError:String(error)})); await fs.appendFile(path.join(root,'audit-errors.jsonl'),JSON.stringify({at:stamp(),error:String(error)})+'\n'); }
  await new Promise(resolve=>setTimeout(resolve,intervalMs));
}
