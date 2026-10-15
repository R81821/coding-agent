// Run with the packaged executable and ELECTRON_RUN_AS_NODE=1:
// "Harness Agent.exe" packaged-smoke.cjs <version> [workspaceRoot] [reportPath]
// Keep this smoke test separate from user data and the already-running app.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function health(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let settled = false;
    let buffer = "";
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => finish(new Error("Daemon health RPC timed out")));
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Daemon health RPC ended without a response")));
    socket.on("connect", () => socket.write(JSON.stringify({ id: "release-health", method: "health" }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 65_536) {
        finish(new Error("Daemon health RPC response exceeded the smoke test limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let forceTimer;
    let deadlineTimer;
    const finish = error => {
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    child.once("exit", onExit);
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    deadlineTimer = setTimeout(() => finish(new Error("Isolated smoke daemon did not exit")), 10_000);
    child.kill("SIGTERM");
  });
}

function cleanScratch(scratch) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const actual = fs.realpathSync(scratch);
  const relative = path.relative(tempRoot, actual);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      path.dirname(actual).toLowerCase() !== tempRoot.toLowerCase() ||
      !path.basename(actual).startsWith("harness-packaged-smoke-")) {
    throw new Error("Refusing cleanup outside the smoke test temporary directory");
  }
  fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  const expectedVersion = process.argv[2];
  assert.match(expectedVersion ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a release version argument");
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1", "Use ELECTRON_RUN_AS_NODE=1 with the actual packaged executable");
  assert.ok(process.versions.electron, "This test must run in the packaged Electron runtime");
  assert.equal(process.platform, "win32", "This smoke test targets the Windows installer");
  assert.equal(process.arch, "x64", "This smoke test targets the x64 installer");
  assert.ok(process.resourcesPath, "Packaged Electron resources path is unavailable");

  const workspaceRoot = path.resolve(process.argv[3] ?? path.join(__dirname, "..", "..", ".."));
  const reportPath = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  const appRoot = path.join(process.resourcesPath, "app.asar");
  const daemonMain = path.join(process.resourcesPath, "daemon", "main.js");
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, expectedVersion, "Packaged app version must match the requested release");
  for (const file of ["dist/index.html", "dist-electron/main.js", "dist-electron/preload.cjs"]) {
    assert.ok(fs.existsSync(path.join(appRoot, file)), `Packaged file missing: ${file}`);
  }

  const assets = path.join(appRoot, "dist", "assets");
  const renderer = fs.readdirSync(assets).filter(name => name.endsWith(".js"))
    .map(name => fs.readFileSync(path.join(assets, name), "utf8")).join("\n");
  assert.ok(renderer.includes(`v${expectedVersion}`), "Packaged renderer version must match the requested release");
  const hashes = {};
  for (const [name, packaged, built] of [
    ["daemonSha256", daemonMain, path.join(workspaceRoot, "apps", "daemon", "dist", "main.js")],
    ["mainSha256", path.join(appRoot, "dist-electron", "main.js"), path.join(workspaceRoot, "apps", "desktop", "dist-electron", "main.js")],
    ["preloadSha256", path.join(appRoot, "dist-electron", "preload.cjs"), path.join(workspaceRoot, "apps", "desktop", "dist-electron", "preload.cjs")],
  ]) {
    hashes[name] = sha256(packaged);
    assert.equal(hashes[name], sha256(built), `Packaged ${name} must match the current build`);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "harness-packaged-smoke-"));
  let child;
  try {
    const sharp = require(path.join(appRoot, "node_modules", "sharp"));
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#7d5ba6" } }).png().toBuffer();
    assert.ok(png.length > 50, "Native sharp must generate a real PNG");
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "Sharp output must have a PNG header");
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);

    const dbFile = path.join(scratch, "native.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE checkup(value TEXT); INSERT INTO checkup VALUES ('ok')");
    } finally {
      db.close();
    }
    const reopened = new DatabaseSync(dbFile);
    try {
      assert.equal(reopened.prepare("SELECT value FROM checkup").get().value, "ok", "Native SQLite must persist and reopen data");
    } finally {
      reopened.close();
    }

    const instance = `release_${randomUUID()}`;
    const pipe = `\\\\.\\pipe\\harness-agent-v2-${instance}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|GATEWAY|HARNESS|PARALLEL|TELEGRAM|FEISHU|GITHUB|OTEL|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/i.test(key)));
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "",
      LOCALAPPDATA: scratch,
      APPDATA: scratch,
      HARNESS_APP_DATA_PATH: path.join(scratch, "data"),
      HARNESS_DAEMON_INSTANCE: instance,
      HARNESS_DESKTOP_PID: String(process.pid),
    });
    child = spawn(process.execPath, [daemonMain], { cwd: scratch, env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let spawnError;
    let stderr = "";
    child.on("error", error => { spawnError = error; });
    child.stdin.on("error", error => { spawnError ??= error; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.end("release-smoke-fixture-password\n");

    const deadline = Date.now() + 30_000;
    let response;
    let lastHealthError;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated smoke daemon exited: ${stderr}`);
      try {
        response = await health(pipe);
        break;
      } catch (error) {
        lastHealthError = error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    assert.ok(response?.ok, `Daemon health did not pass: ${String(lastHealthError ?? "no response").slice(0, 500)} ${stderr}`);
    assert.equal(response.result.status, "ok");
    assert.equal(response.result.version, expectedVersion, "Real packaged daemon health version must match the requested release");
    assert.deepEqual(response.result.providerIds, [], "Isolated smoke daemon must not load user provider credentials");
    assert.deepEqual(response.result.connectors, [], "Isolated smoke daemon must not start user message connectors");

    const result = {
      version: manifest.version,
      electron: process.versions.electron,
      node: process.versions.node,
      arch: process.arch,
      packagedFiles: "passed",
      rendererVersion: expectedVersion,
      packagedBuildHashes: hashes,
      sharpPngBytes: png.length,
      sqliteRoundTrip: "passed",
      daemonHealth: {
        status: response.result.status,
        version: response.result.version,
        providerIds: response.result.providerIds,
        connectors: response.result.connectors,
      },
    };
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, serialized);
    }
    console.log(JSON.stringify(result));
  } finally {
    await stopChild(child);
    cleanScratch(scratch);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
