import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** A stale marker or a partially replaced build cannot authorize this dev launch. */
export async function isCurrentDesktopBuildReady(outputDirectory, buildId) {
  try {
    const manifest = JSON.parse(await readFile(join(outputDirectory, ".build-ready.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.buildId !== buildId) return false;
    for (const filename of ["main.js", "preload.cjs"]) {
      const expected = manifest.hashes?.[filename];
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
      const actual = createHash("sha256").update(await readFile(join(outputDirectory, filename))).digest("hex");
      if (actual !== expected) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof SyntaxError || error.code === "ENOENT") return false;
    throw error;
  }
}

function serverReady(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = ready => { socket.destroy(); resolve(ready); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function waitForDesktopDevelopment({ outputDirectory, buildId, host = "127.0.0.1", port = 5173, timeoutMs = 120_000, intervalMs = 50, signal }) {
  if (typeof buildId !== "string" || !/^[A-Za-z0-9_-]+$/.test(buildId)) throw new Error("Missing current desktop build ID");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await isCurrentDesktopBuildReady(outputDirectory, buildId) && await serverReady(host, port)) return;
    await delay(intervalMs, undefined, signal ? { signal } : undefined);
  }
  throw new Error("Desktop startup timed out waiting for this build and the Vite server");
}
