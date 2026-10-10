import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const executable = [join(repo, ".cache", "electron-dist", "electron.exe"), join(repo, "apps", "desktop", "node_modules", "electron", "dist", "electron.exe")].find(existsSync);
type Capture = { output: { url: string; title: string; mimeType: string; width: number; height: number; scope: string }; pngSignature: number[]; byteLength: number; imageSize: { width: number; height: number }; topLeftBGRA: number[]; empty: boolean };
type Observation = { viewport: Capture; fullPage: Capture; visible: boolean; url: string; offscreen: boolean };

async function captureWithElectron(root: string): Promise<Observation> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(executable!, [join(repo, "tests", "fixtures", "browser-screenshot-electron.cjs"), repo, root], { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Native Electron screenshot timed out.\n${stderr}`)); }, 35000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Native Electron screenshot exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const result = stdout.split(/\r?\n/).find(line => line.startsWith("SCREENSHOT_FIXTURE_RESULT:"));
      if (!result) { reject(new Error(`Native Electron produced no screenshot receipt.\n${stderr}\n${stdout}`)); return; }
      try { resolve(JSON.parse(result.slice("SCREENSHOT_FIXTURE_RESULT:".length)) as Observation); }
      catch (error) { reject(error); }
    });
  });
}

it.skipIf(!executable)("uses the production host screenshot method to capture colored viewport and full-page pixels from hidden offscreen Electron", { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-native-screenshot-"));
  try {
    const observed = await captureWithElectron(root);
    expect(observed.visible).toBe(false);
    expect(observed.offscreen).toBe(true);
    for (const capture of [observed.viewport, observed.fullPage]) {
      expect(capture.empty).toBe(false);
      expect(capture.pngSignature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(capture.byteLength).toBeGreaterThan(100);
      expect(capture.output).toMatchObject({ url: observed.url, title: "Native screenshot fixture", mimeType: "image/png" });
      expect(capture.imageSize).toEqual({ width: capture.output.width, height: capture.output.height });
      expect(capture.topLeftBGRA).toEqual([40, 30, 230, 255]);
    }
    expect(observed.viewport.output).toMatchObject({ width: 420, height: 260, scope: "viewport" });
    expect(observed.fullPage.output.scope).toBe("full_page");
    expect(observed.fullPage.output.height).toBeGreaterThan(observed.viewport.output.height);
    expect(observed.fullPage.output.height).toBeGreaterThanOrEqual(1300);
  } finally {
    const confined = relative(tmpdir(), root);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error("Unsafe Electron fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});
