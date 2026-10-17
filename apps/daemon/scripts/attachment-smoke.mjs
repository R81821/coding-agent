import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const workspace = resolve(import.meta.dirname, "..", "..", "..");
await mkdir(join(workspace, ".cache"), { recursive: true });
const directory = await mkdtemp(join(workspace, ".cache", "attachment-bundle-smoke-"));
const vaultPath = join(directory, "vault");
await mkdir(vaultPath);
const instanceId = `attachment_smoke_${randomUUID().replaceAll("-", "")}`;
const endpoint = `harness-agent-v2-${instanceId}`;
const pipe = process.platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : join(tmpdir(), `${endpoint}.sock`);
const env = {};
for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory,
  HARNESS_APP_DATA_PATH: vaultPath,
  HARNESS_APP_PASSPHRASE: randomBytes(32).toString("base64"),
  HARNESS_DAEMON_INSTANCE: instanceId,
  HARNESS_DESKTOP_PID: String(process.pid),
});
const child = spawn(process.execPath, [join(workspace, "apps", "daemon", "dist", "main.js")], {
  cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "", stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", value => { stdout = (stdout + value).slice(-20_000); });
child.stderr.on("data", value => { stderr = (stderr + value).slice(-20_000); });
const report = { runtime: process.version, directory, childPid: child.pid, tests: [], uploads: [], success: false };

function rpc(params) {
  const id = randomUUID();
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(pipe);
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Attachment RPC timed out")); }, 30_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id, method: "attachment.put", params }) + "\n"));
    socket.on("data", value => {
      response += value;
      const index = response.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = JSON.parse(response.slice(0, index));
        assert.equal(parsed.id, id);
        resolveRequest(parsed);
      } catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

try {
  await new Promise((resolveStartup, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon startup timeout: ${stderr}`)), 30_000);
    child.stdout.on("data", () => {
      if (stdout.includes("Harness Agent daemon listening on")) { clearTimeout(timer); resolveStartup(); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Daemon exited during startup: ${code}/${signal}\n${stderr}`)); });
  });
  report.tests.push("production daemon starts with isolated vault and unique pipe");
  const files = [
    { fileName: "sample.tsx", mimeType: "text/plain", bytes: Buffer.from('export const sample = "Attachment parser sample";\n') },
    { fileName: "attachment-sample.pdf", mimeType: "application/pdf", bytes: await readFile(join(workspace, "tests", "fixtures", "attachment-sample.pdf")) },
    { fileName: "attachment-sample.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: await readFile(join(workspace, "tests", "fixtures", "attachment-sample.docx")) },
    { fileName: "sample.png", mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yXfoAAAAASUVORK5CYII=", "base64") },
  ];
  for (const input of files) {
    const response = await rpc({ base64: input.bytes.toString("base64"), mimeType: input.mimeType, fileName: `C:\\fixture\\${input.fileName}`, source: "file", allowedProviders: ["smoke-provider"] });
    assert.equal(response.ok, true, JSON.stringify(response));
    const attachment = response.result;
    assert.equal(attachment.fileName, input.fileName);
    assert.equal(attachment.mimeType, input.mimeType);
    assert.equal(attachment.byteLength, input.bytes.byteLength);
    assert.equal(attachment.trust, "untrusted_attachment");
    assert.deepEqual(attachment.allowedProviders, ["smoke-provider"]);
    if (input.mimeType !== "image/png") assert.ok(attachment.textTokenEstimate > 0);
    const rel = relative(vaultPath, resolve(attachment.encryptedPath));
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "encrypted blob must remain in dedicated smoke vault");
    const encrypted = await readFile(attachment.encryptedPath);
    assert.equal(encrypted.includes(input.bytes), false);
    report.uploads.push({ fileName: attachment.fileName, mimeType: attachment.mimeType, byteLength: attachment.byteLength, textTokenEstimate: attachment.textTokenEstimate, id: attachment.id });
    report.tests.push(`real attachment.put succeeds and encrypts ${input.fileName}`);
  }
  for (const input of [
    { bytes: Buffer.from([0, 1, 2, 3, 0xff]), fileName: "unsupported.exe", mimeType: "application/octet-stream" },
    { bytes: Buffer.from("%PDF-1.7\ninvalid file"), fileName: "broken.pdf", mimeType: "application/pdf" },
  ]) {
    const response = await rpc({ base64: input.bytes.toString("base64"), mimeType: input.mimeType, fileName: input.fileName, source: "file", allowedProviders: [] });
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.ok(response.error);
    report.tests.push(`real attachment.put rejects ${input.fileName}`);
  }
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await stopped;
  }
  report.childStopped = child.exitCode !== null || child.signalCode !== null;
  // Delete only the vault created by this invocation; keep its result and bounded log.
  const ownDirectory = relative(resolve(workspace, ".cache"), resolve(directory));
  const ownVault = relative(resolve(directory), resolve(vaultPath));
  assert.match(ownDirectory, /^attachment-bundle-smoke-[a-zA-Z0-9]+$/);
  assert.equal(resolve(directory, ".."), resolve(workspace, ".cache"));
  assert.equal(ownVault, "vault");
  await rm(resolve(vaultPath), { recursive: true, force: true });
  report.vaultRemoved = true;
  await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2));
  await writeFile(join(directory, "daemon.log"), stdout + "\n" + stderr);
}
console.log(JSON.stringify(report, null, 2));
