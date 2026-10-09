// Exercise Electron's actual main-process loader, preload and renderer load.
// Use isolated storage and suppress startup registration; never unlock a user's vault.
const { app, dialog } = require("electron");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = mkdtempSync(join(tmpdir(), "harness-electron-smoke-"));
app.setPath("userData", join(root, "user-data"));
app.setPath("sessionData", join(root, "session-data"));
app.setAppLogsPath(join(root, "logs"));
process.env.LOCALAPPDATA = root;
process.env.APPDATA = root;
if (!process.argv.includes("--dev")) delete process.env.VITE_DEV_SERVER_URL;
app.setLoginItemSettings = () => {};
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  process.stderr.write(`${error ? `FAIL: ${error.stack ?? error}` : "PASS: Electron main, preload and renderer document loaded"}\n`);
  app.exit(error ? 1 : 0);
}
dialog.showErrorBox = (title, message) => finish(new Error(`${title}: ${message}`));
process.on("uncaughtException", finish);
process.on("unhandledRejection", finish);
setTimeout(() => finish(new Error("Desktop startup timed out after 30 seconds")), 30_000);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("preload-error", (_event, _path, error) => finish(error));
  window.webContents.on("did-fail-load", (_event, code, description) => finish(new Error(`${code}: ${description}`)));
  window.webContents.on("render-process-gone", (_event, details) => finish(new Error(`Renderer exited: ${details.reason}`)));
  window.webContents.once("did-finish-load", () => finish());
});
void import(pathToFileURL(resolve(__dirname, "..", "dist-electron/main.js")).href).catch(finish);
