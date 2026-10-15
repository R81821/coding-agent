import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDevelopmentServer, desktopWatchCommand } from "./dev-config.mjs";

const require = createRequire(import.meta.url);
const { concurrently } = require("concurrently");
process.env.HARNESS_DESKTOP_BUILD_ID = randomUUID();
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = desktopDevelopmentServer();
// One initial watch build publishes both complete bundles. Electron waits for its unique marker,
// while later watch rebuilds publish atomically without restarting the running app or daemon.
const { result } = concurrently([
  { name: "renderer", command: `vite --host ${server.host} --port ${server.port} --strictPort` },
  { name: "main", command: desktopWatchCommand },
  { name: "desktop", command: "node scripts/dev-start.mjs" },
], { cwd: desktopRoot, killOthersOn: ["failure", "success"], successCondition: "first" });
try { await result; }
catch { process.exitCode = 1; }
