import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForDesktopDevelopment } from "./dev-ready.mjs";
import { desktopDevelopmentServer } from "./dev-config.mjs";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = desktopDevelopmentServer();
const started = performance.now();
console.log("[Harness Agent] 等待开发构建和页面服务就绪…");
await waitForDesktopDevelopment({ outputDirectory: join(desktopRoot, "dist-electron"), buildId: process.env.HARNESS_DESKTOP_BUILD_ID, host: server.host, port: server.port });
console.log(`[Harness Agent] 开发环境就绪（${((performance.now() - started) / 1000).toFixed(1)} 秒），正在打开窗口`);

// The smoke entry isolates storage and never unlocks or contacts a user's provider.
const smokeMode = process.env.HARNESS_DESKTOP_DEV_SMOKE;
const smoke = smokeMode === "1" || smokeMode === "foreground";
const backgroundSmoke = smoke && smokeMode !== "foreground";
const argumentsForElectron = smoke ? [join(desktopRoot, "scripts", "smoke.cjs"), "--dev", ...(backgroundSmoke ? ["--background"] : [])] : ["."];
const child = spawn(require("electron"), argumentsForElectron, {
  // Hiding a Windows GUI process can suppress its first window as well as a console.
  cwd: desktopRoot, stdio: "inherit", windowsHide: backgroundSmoke,
  env: { ...process.env, NODE_OPTIONS: "", VITE_DEV_SERVER_URL: server.url },
});
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
