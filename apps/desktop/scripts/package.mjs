import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { downloadArtifact, ElectronDownloadCacheMode } from "@electron/get";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..", "..", "..");
const version = "37.3.1";
const filename = `electron-v${version}-win32-x64.zip`;
const expectedSha256 = "32ad7124107ffef2aa92abb03175c4a8a60133d50cda338c2ab2917c5efc8c32";
const distRoot = join(workspaceRoot, ".cache", "electron-dist");
const target = join(distRoot, filename);

await mkdir(distRoot, { recursive: true });
if (!await valid(target)) {
  const downloaded = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: "win32",
    arch: "x64",
    cacheRoot: join(workspaceRoot, ".cache", "electron"),
    cacheMode: ElectronDownloadCacheMode.ReadWrite,
    checksums: { [filename]: expectedSha256 }
  });
  if (!await valid(downloaded)) throw new Error(`Electron archive checksum mismatch: ${downloaded}`);
  await copyFile(downloaded, target);
}
if (!await valid(target)) throw new Error(`Electron archive checksum mismatch: ${target}`);

const require = createRequire(import.meta.url);
const builderCli = require.resolve("electron-builder/cli.js");
const code = await new Promise((resolveExit, rejectExit) => {
  const child = spawn(process.execPath, [builderCli, "--win", "nsis", "--x64"], {
    cwd: resolve(here, ".."),
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ELECTRON_BUILDER_CACHE: join(workspaceRoot, ".cache", "electron-builder") }
  });
  child.on("error", rejectExit);
  child.on("exit", (exitCode) => resolveExit(exitCode ?? 1));
});
if (code !== 0) process.exit(code);

async function valid(path) {
  try {
    if ((await stat(path)).size < 100_000_000) return false;
    const hash = createHash("sha256");
    await new Promise((resolveHash, rejectHash) => {
      const stream = createReadStream(path);
      stream.on("error", rejectHash);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolveHash);
    });
    return hash.digest("hex") === expectedSha256;
  } catch { return false; }
}
