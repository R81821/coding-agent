// Run with: node apps/desktop/scripts/daemon-dev-smoke.mjs
// Exercise the desktop's real development launcher and stop helper against an
// isolated vault. No user env file, vault, provider or remote service is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = resolve(import.meta.dirname, "../../..");
const desktopRequire = createRequire(join(workspace, "apps/desktop/package.json"));
const { tsImport } = await import(pathToFileURL(desktopRequire.resolve("tsx/esm/api")).href);
const { developmentDaemonCommand } = await tsImport(pathToFileURL(join(workspace, "apps/desktop/src/daemon-launch.ts")).href, import.meta.url);
const { stopDaemonProcess } = await tsImport(pathToFileURL(join(workspace, "apps/desktop/src/daemon-process.ts")).href, import.meta.url);
const runtime = process.argv.includes("--node") ? process.execPath : desktopRequire("electron");

await mkdir(join(workspace, ".cache"), { recursive: true });
const directory = await mkdtemp(join(workspace, ".cache/daemon-dev-smoke-"));
const vault = join(directory, "vault");
await mkdir(vault);
const instanceId = `dev_smoke_${randomUUID().replaceAll("-", "")}`;
const endpointName = `harness-agent-v2-${instanceId}`;
const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${endpointName}` : join(tmpdir(), `${endpointName}.sock`);
const env = {};
for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory,
  ELECTRON_RUN_AS_NODE: "1", TSX_DISABLE_CACHE: "1",
  HARNESS_APP_DATA_PATH: vault,
  HARNESS_APP_PASSPHRASE: randomBytes(32).toString("base64"),
  HARNESS_DAEMON_INSTANCE: instanceId,
  HARNESS_DESKTOP_PID: String(process.pid),
});
// Keep the launcher's real cwd while preventing main.ts from loading a future
// developer .env. The preload executes before the original daemon entry point.
const isolationPreload = join(directory, "isolation-preload.mjs");
await writeFile(isolationPreload, `process.loadEnvFile=()=>process.stderr.write("HARNESS_SMOKE_ENV_LOAD_BLOCKED\\n");globalThis.fetch=async()=>{throw new Error("Daemon smoke forbids outbound fetch")};\n`);
const command = developmentDaemonCommand(workspace);
assert.equal(resolve(command.cwd), join(workspace, "apps/daemon"));
assert.equal(resolve(command.args.at(-1)), join(workspace, "apps/daemon/src/main.ts"));
const args = [...command.args.slice(0, -1), "--import", pathToFileURL(isolationPreload).href, command.args.at(-1)];
const children = [];
const report = { directory, runtime, runnerVersion: process.version, success: false, checks: [], rounds: [] };
const pass = label => report.checks.push(label);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function rpc(method, params) {
  const id = randomUUID();
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(endpoint);
    let response = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveRequest(value);
    };
    const timer = setTimeout(() => finish(new Error(`Daemon smoke RPC timed out: ${method}`)), 1500);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n"));
    socket.on("data", value => {
      response += value;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        assert.equal(parsed.id, id);
        assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
        finish(undefined, parsed.result);
      } catch (error) { finish(error); }
    });
    socket.once("error", error => finish(error));
    socket.once("end", () => { if (!settled) finish(new Error("Daemon closed the RPC socket before responding")); });
  });
}
async function lockOwner() {
  try { return Number(await readFile(join(vault, "harness.sqlite.lock"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function start(round) {
  const child = spawn(runtime, args, { cwd: command.cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, stdout: "", stderr: "", spawnError: undefined };
  children.push(state);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { state.stdout = (state.stdout + value).slice(-20_000); });
  child.stderr.on("data", value => { state.stderr = (state.stderr + value).slice(-20_000); });
  child.once("error", error => { state.spawnError = error; });
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (state.spawnError) throw state.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Round ${round} daemon exited during startup (${child.exitCode}/${child.signalCode}): ${state.stderr}`);
    try {
      const health = await rpc("health");
      assert.equal(health.status, "ok");
      assert.deepEqual(health.providerIds, []);
      assert.deepEqual(health.connectors, []);
      assert.equal(await lockOwner(), child.pid, "the spawned child must own the vault directly, without a launcher descendant");
      assert.ok(state.stderr.includes("HARNESS_SMOKE_ENV_LOAD_BLOCKED"));
      const result = { round, pid: child.pid, lockOwner: child.pid, health, stopped: false };
      report.rounds.push(result);
      pass(`round ${round}: development daemon answers health without providers/connectors and owns its vault directly`);
      return { state, result };
    } catch (error) { lastError = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Round ${round} daemon startup timed out: ${String(lastError)}\n${state.stderr}`);
}
async function stop(started) {
  const { state, result } = started;
  const began = Date.now();
  await stopDaemonProcess(state.child);
  assert.ok(state.child.exitCode !== null || state.child.signalCode !== null, "stop helper must await the actual child exit event");
  assert.equal(isAlive(state.child.pid), false, "stop helper must return only after the daemon PID is gone");
  const owner = await lockOwner();
  if (owner !== undefined) {
    assert.equal(owner, state.child.pid);
    assert.equal(isAlive(owner), false, "any force-kill lock must belong to a dead process so restart can reclaim it");
  }
  await assert.rejects(rpc("health"), "the stopped daemon must no longer answer on its pipe");
  result.stopped = true;
  result.stopMs = Date.now() - began;
  result.lockAfterStop = owner ?? null;
  pass(`round ${result.round}: stop waits for process exit, pipe closure and release of every live lock owner`);
}
const session = { id: `restart_${randomUUID()}`, workspacePath: directory, profileId: "default", title: "Daemon dev restart smoke", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
try {
  const first = await start(1);
  await rpc("sessions.create", session);
  const identity = createHash("sha256").update(await readFile(join(vault, "key-envelope.json"))).digest("hex");
  await stop(first);
  // Deliberately no delay: this is the desktop's retry/restart race regression.
  const second = await start(2);
  assert.notEqual(second.state.child.pid, first.state.child.pid);
  const sessions = await rpc("sessions.list", { deleted: false, limit: 50, offset: 0 });
  assert.ok(sessions.items.some(item => item.id === session.id && item.title === session.title), "the same vault must preserve its existing session across immediate restart");
  assert.equal(createHash("sha256").update(await readFile(join(vault, "key-envelope.json"))).digest("hex"), identity);
  pass("immediate restart reopens the same vault, preserves its encryption identity and restores its saved session");
  await stop(second);
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const state of children) {
    if (!state.child.pid || !isAlive(state.child.pid)) continue;
    try { await stopDaemonProcess(state.child); }
    catch (error) { cleanupErrors.push(String(error)); }
  }
  report.childrenStopped = children.every(state => !state.child.pid || !isAlive(state.child.pid));
  if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
  if (!report.childrenStopped) { report.success = false; process.exitCode = 1; }
  // Verify the exact generated directory before recursively deleting this
  // invocation's vault. Keep the bounded logs and result for inspection.
  const ownDirectory = relative(join(workspace, ".cache"), directory);
  assert.match(ownDirectory, /^daemon-dev-smoke-[a-zA-Z0-9]+$/);
  assert.equal(resolve(directory, ".."), join(workspace, ".cache"));
  assert.equal(relative(directory, vault), "vault");
  assert.equal(isAbsolute(relative(directory, vault)), false);
  if (report.childrenStopped) {
    await rm(vault, { recursive: true, force: true });
    report.vaultRemoved = true;
  }
  for (let index = 0; index < children.length; index++) {
    await writeFile(join(directory, `daemon-${index + 1}.log`), children[index].stdout + "\n" + children[index].stderr);
  }
  await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
