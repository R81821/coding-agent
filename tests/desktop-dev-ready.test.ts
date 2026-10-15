import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
// @ts-expect-error Development launcher is a Node ESM script, not production TypeScript.
import { isCurrentDesktopBuildReady, waitForDesktopDevelopment } from "../apps/desktop/scripts/dev-ready.mjs";
// @ts-expect-error Development configuration is consumed directly by Node.
import { desktopDevelopmentServer } from "../apps/desktop/scripts/dev-config.mjs";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-dev-ready-"));
  cleanup.push(async () => {
    const delta = relative(resolve(tmpdir()), resolve(root));
    if (!delta || delta.startsWith("..") || !root.includes("harness-dev-ready-")) throw new Error("Invalid fixture cleanup root");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  return root;
}
async function publish(root: string, buildId: string) {
  const hashes: Record<string, string> = {};
  for (const [filename, text] of [["main.js", "export const complete = true;"], ["preload.cjs", "module.exports = true;"]] as const) {
    await writeFile(join(root, filename), text);
    hashes[filename] = createHash("sha256").update(text).digest("hex");
  }
  await writeFile(join(root, ".build-ready.json"), JSON.stringify({ schemaVersion: 1, buildId, hashes }));
}
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.unshift(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  return { server, port: (server.address() as { port: number }).port };
}

describe("desktop development startup readiness", () => {
  it("uses the same loopback server address for Vite and Electron on default and isolated ports", () => {
    expect(desktopDevelopmentServer({})).toEqual({ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173" });
    expect(desktopDevelopmentServer({ HARNESS_DESKTOP_DEV_PORT: "5188" })).toEqual({ host: "127.0.0.1", port: 5188, url: "http://127.0.0.1:5188" });
  });

  it("rejects invalid ports before interpolating them into a shell command", () => {
    for (const port of ["", "0", "65536", "-1", "5173.5", "5173 & echo unexpected"]) {
      expect(() => desktopDevelopmentServer({ HARNESS_DESKTOP_DEV_PORT: port })).toThrow("HARNESS_DESKTOP_DEV_PORT");
    }
  });

  it("rejects stale markers, missing bundles and mismatched or truncated files", async () => {
    const root = await fixture();
    expect(await isCurrentDesktopBuildReady(root, "current")).toBe(false);
    await publish(root, "old");
    expect(await isCurrentDesktopBuildReady(root, "current")).toBe(false);
    await publish(root, "current");
    expect(await isCurrentDesktopBuildReady(root, "current")).toBe(true);
    const complete = await readFile(join(root, "main.js"));
    await writeFile(join(root, "main.js"), complete.subarray(0, 5));
    expect(await isCurrentDesktopBuildReady(root, "current")).toBe(false);
    await writeFile(join(root, "main.js"), complete);
    await rm(join(root, "preload.cjs"));
    expect(await isCurrentDesktopBuildReady(root, "current")).toBe(false);
  });

  it("waits for this process's completed build even when the server and an old build already exist", async () => {
    const root = await fixture(), { port } = await listen();
    await publish(root, "old");
    let ready = false;
    const started = waitForDesktopDevelopment({ outputDirectory: root, buildId: "current", port, timeoutMs: 1000, intervalMs: 5 }).then(() => { ready = true; });
    await new Promise(done => setTimeout(done, 20));
    expect(ready).toBe(false);
    await publish(root, "current");
    await started;
    expect(ready).toBe(true);
  });

  it("does not start while Vite is unavailable and permits cancellation", async () => {
    const root = await fixture();
    await publish(root, "current");
    const { server, port } = await listen();
    await new Promise<void>(done => server.close(() => done()));
    // Remove the already closed server's cleanup.
    cleanup.shift();
    await expect(waitForDesktopDevelopment({ outputDirectory: root, buildId: "current", port, timeoutMs: 50, intervalMs: 5 })).rejects.toThrow("timed out");
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    await expect(waitForDesktopDevelopment({ outputDirectory: root, buildId: "current", port, signal: controller.signal })).rejects.toThrow("fixture cancelled");
  });
});
