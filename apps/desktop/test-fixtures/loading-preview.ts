import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Render the real conversation component without mounting App or connecting to a daemon.
const vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { middlewareMode: true },
  appType: "custom",
  plugins: [{
    name: "conversation-loading-preview",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").includes("/src/renderer.tsx?loading-preview")) return;
      const mount = code.lastIndexOf('createRoot(document.getElementById("root")!');
      if (mount < 0) throw new Error("Could not isolate conversation renderer for preview");
      return code.slice(0, mount) + "\nexport { ConversationTurnView };\n";
    },
  }, react(), tailwindcss()],
});
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Harness 小灰嘎动画预览</title></head><body>
<div id="root"></div><script type="module">
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationTurnView} from '/src/renderer.tsx?loading-preview';
window.harness = {request: async () => undefined};
function Preview() {
  const [phase,setPhase] = useState('streaming');
  const [theme,setTheme] = useState('kelo');
  const [reduced,setReduced] = useState(false);
  document.documentElement.dataset.theme = theme;
  const base = {runId:'preview',at:'2026-09-26T00:00:00.000Z',sequence:0};
  const text = '小灰嘎正在拿着彩色风车走路。\\n\\n生成中的动画放在这段回答的左下方，风车与脚步循环变化。';
  const events = phase === 'waiting' ? [] : [{...base,id:'text',type:'text_delta',delta:text}];
  if (phase === 'completed') events.push({...base,id:'done',sequence:1,type:'result',status:'completed',text});
  const e = React.createElement;
  return e('div',{className:'workbench',style:{height:'100vh',padding:20,background:theme==='kelo'?'#fff':'#211e27'}},
    reduced && e('style',null,'.xiaohuiga-walk {animation:none !important}'),
    e('main',{style:{height:'100%',display:'grid',gridTemplateRows:'58px minmax(0,1fr)'}},
      e('header',{className:'topbar',style:{display:'flex',gap:12}},
        e('strong',null,'小灰嘎动画预览'),
        e('select',{'aria-label':'生成阶段',value:phase,onChange:x=>setPhase(x.target.value)},
          ...[['waiting','尚未输出'],['streaming','正在生成'],['completed','生成完成']].map(([value,label])=>e('option',{key:value,value},label))),
        e('button',{onClick:()=>setTheme(theme==='kelo'?'classic':'kelo')},'切换深浅主题'),
        e('button',{onClick:()=>setReduced(!reduced)},reduced?'恢复动画':'减少动态效果')),
      e('div',{className:'conversation'},
        e(ConversationTurnView,{turn:{runId:'preview',request:'请展示小灰嘎的风车步行动画',status:phase==='completed'?'completed':'running',events},busy:phase!=='completed'}))));
}
createRoot(document.getElementById('root')).render(React.createElement(Preview));
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === "/") response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await vite.transformIndexHtml("/", html));
  else vite.middlewares(request, response, () => response.writeHead(404).end());
});
await new Promise<void>(resolve => server.listen(5198, "127.0.0.1", resolve));
const temporary = await mkdtemp(join(tmpdir(), "harness-loading-preview-"));
const launcher = join(temporary, "preview.cjs");
await writeFile(launcher, `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(temporary, "user-data"))}); let win; app.whenReady().then(()=>{win=new BrowserWindow({width:1050,height:720,autoHideMenuBar:true});win.webContents.on('console-message',(_event,_level,message)=>console.log(message));win.loadURL('http://127.0.0.1:5198/');win.show();});app.on('window-all-closed',()=>app.quit());`);
const child = spawn(electron as unknown as string, [launcher], { stdio: "inherit" });
console.log("Loading preview: http://127.0.0.1:5198");
async function close() {
  await vite.close(); server.close(); server.closeAllConnections();
  await rm(launcher, { force: true });
  process.exit(0);
}
child.once("exit", () => void close());
process.once("SIGINT", () => child.kill());
process.once("SIGTERM", () => child.kill());
