import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { downloadArtifact, ElectronDownloadCacheMode } from "@electron/get";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..", "..", "..");
const version = "41.10.6";
const manifest = JSON.parse(await readFile(resolve(here, "..", "package.json"), "utf8"));
if (manifest.devDependencies.electron !== version) throw new Error("Electron package and verified archive versions must match");
const filename = `electron-v${version}-win32-x64.zip`;
// Official v41.10.6 SHASUMS256.txt, electron-v41.10.6-win32-x64.zip.
const expectedSha256 = "5447c50d196c2227e396716ea969869c1e5baa12b6af7fb33f75ae897a6853aa";
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
