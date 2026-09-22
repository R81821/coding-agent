import { connect } from "node:net";
import { readFileSync, readdirSync } from "node:fs";

const dir = "C:/Users/13437/AppData/Local/Temp/claude/D--qweai/df055f6e-d76c-4341-b72a-b2481988694a/tasks";
const files = readdirSync(dir).filter((f) => f.endsWith(".output"));
let PIPE = "";
for (const f of files) {
  const t = readFileSync(`${dir}/${f}`, "utf8").match(/harness-agent-v2-desktop_[0-9a-f-]+/g)?.at(-1);
  if (t) PIPE = t;
}
if (!PIPE) { console.log("no pipe"); process.exit(1); }
console.log("pipe:", PIPE);

let idc = 0;
function req(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = connect(`\\\\.\\pipe\\${PIPE}`);
    let buffer = "";
    const id = `probe-${++idc}`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer); socket.end();
      try { resolve(JSON.parse(buffer.slice(0, nl))); } catch (e) { reject(e); }
    });
    socket.on("error", (e) => { clearTimeout(timer); reject(new Error(`${method}: ${e.message}`)); });
  });
}
console.log("health ->", JSON.stringify((await req("health")).result));
console.log("search.status ->", JSON.stringify((await req("search.status")).result));
