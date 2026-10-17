import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../../..");
await mkdir(join(root, ".cache"), { recursive: true });
const scratch = await mkdtemp(join(root, ".cache/memory-smoke-"));
const project = join(scratch, "project");
await mkdir(project);
await writeFile(join(project, "AGENTS.md"), "# 手写规范\n保留此处。\n");
const instance = `memory_${randomUUID().replaceAll("-", "")}`;
const pipe = process.platform === "win32" ? `\\\\.\\pipe\\harness-agent-v2-${instance}` : join(tmpdir(), `harness-agent-v2-${instance}.sock`);
const env = {};
for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE"]) if (process.env[name]) env[name] = process.env[name];
Object.assign(env, { HARNESS_APP_DATA_PATH: join(scratch, "vault"), HARNESS_APP_PASSPHRASE: randomBytes(32).toString("base64"), HARNESS_DAEMON_INSTANCE: instance, HARNESS_DESKTOP_PID: String(process.pid) });
let child, log = "";
async function start() {
  child = spawn(process.execPath, [join(root, "apps/daemon/dist/main.js")], { cwd: scratch, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-20000); });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${log}`)), 20000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("daemon listening")) { clearTimeout(timer); resolveReady(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Daemon exited: ${code} ${log}`)); });
  });
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
}
function rpc(method, params = {}) {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(pipe), id = randomUUID(); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`RPC timeout: ${method}`)); }, 10000);
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", data => {
      buffer += data; if (!buffer.includes("\n")) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(buffer.split("\n")[0]); assert.equal(response.id, id); assert.equal(response.ok, true, JSON.stringify(response)); resolveResult(response.result); }
      catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}
try {
  await start();
  const profile = (await rpc("profiles.list"))[0];
  assert.ok(profile.memoryScopes.includes("global"));
  const input = { scope: "project", scopeId: project, kind: "convention", key: "ui.library", content: "本项目使用 shadcn。", actor: "desktop:user" };
  const rule = await rpc("memory.create", input); assert.equal(rule.status, "approved");
  assert.equal((await rpc("memory.create", input)).id, rule.id);
  const replacement = await rpc("memory.create", { ...input, content: "本项目优先使用 shadcn Base UI。" });
  assert.equal(replacement.status, "candidate"); assert.deepEqual(replacement.conflictIds, [rule.id]);
  await rpc("memory.decide", { memoryId: replacement.id, approved: true, replaceConflicts: true, actor: "desktop:user" });
  const preview = await rpc("memory.publishPreview", { workspacePath: project, memoryIds: [replacement.id] });
  await rpc("memory.publish", { workspacePath: project, memoryIds: preview.memoryIds, token: preview.token });
  const agents = await readFile(join(project, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("保留此处。") && agents.includes(replacement.content));
  assert.equal((await rpc("project.inspect", { workspacePath: project })).trusted, true);
  await rpc("profiles.memoryScopes", { profileId: profile.id, memoryScopes: ["session", "project"] });
  await stop(); await start();
  assert.deepEqual((await rpc("profiles.list"))[0].memoryScopes, ["session", "project"]);
  const records = await rpc("memory.list");
  assert.equal(records.find(item => item.id === rule.id).status, "superseded");
  assert.equal(records.find(item => item.id === replacement.id).status, "approved");
  console.log(JSON.stringify({ success: true, scratch, checks: ["default global memory", "manual create and deduplication", "conflict replacement", "real project files and trust", "scope opt-out survives restart", "encrypted records survive restart"] }, null, 2));
} finally { await stop(); }
