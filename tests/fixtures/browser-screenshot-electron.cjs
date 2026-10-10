// This fixture loads the source host directly; it never builds or opens the desktop app.
const { app, BrowserWindow, nativeImage } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const repo = process.argv[2];
const root = process.argv[3];
const desktopRequire = createRequire(join(repo, "apps", "desktop", "package.json"));
require(desktopRequire.resolve("tsx/cjs"));
const { DesktopBrowserHost } = require(join(repo, "apps", "desktop", "src", "browser-host.ts"));

for (const directory of ["user-data", "session-data", "logs", "workspace"]) mkdirSync(join(root, directory), { recursive: true });
app.setPath("userData", join(root, "user-data"));
app.setPath("sessionData", join(root, "session-data"));
app.setAppLogsPath(join(root, "logs"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let host;
let window;
let stage = "initialization";
let finished = false;
function finish(error, observation) {
  if (finished) return;
  finished = true;
  if (error) process.stderr.write(`SCREENSHOT_FIXTURE_FAILED (${stage}): ${error.stack ?? error}\n`);
  else process.stdout.write(`SCREENSHOT_FIXTURE_RESULT:${JSON.stringify(observation)}\n`);
  try { host?.close(); window?.destroy(); } catch { /* Exit still releases this fixture's isolated processes. */ }
  app.exit(error ? 1 : 0);
}
process.on("uncaughtException", finish);
process.on("unhandledRejection", finish);
setTimeout(() => finish(new Error("Hidden Electron screenshot fixture exceeded 30 seconds")), 30000);

function imageObservation(result) {
  const bytes = Buffer.from(result.images[0].base64, "base64");
  const image = nativeImage.createFromBuffer(bytes);
  const bitmap = image.toBitmap();
  return {
    output: result.output,
    pngSignature: [...bytes.subarray(0, 8)],
    byteLength: bytes.byteLength,
    imageSize: image.getSize(),
    // NativeImage bitmap uses BGRA; the canvas top-left is a deterministic solid red square.
    topLeftBGRA: [...bitmap.subarray(0, 4)],
    empty: image.isEmpty(),
  };
}

void app.whenReady().then(async () => {
  const workspace = join(root, "workspace");
  const page = join(workspace, "canvas.html");
  writeFileSync(page, `<!doctype html><html><head><title>Native screenshot fixture</title><style>
    html,body{margin:0;width:100%;min-height:1300px;background:rgb(20,40,80)}
    canvas{display:block;width:200px;height:100px}
    </style></head><body><canvas id="canvas" width="200" height="100"></canvas><script>
    const context=document.getElementById('canvas').getContext('2d');
    context.fillStyle='rgb(230,30,40)';context.fillRect(0,0,200,100);
    </script></body></html>`);
  // A freshly hidden native child View has no compositor surface on Windows. The offscreen
  // WebContents gives the production screenshot method a real rendered surface without showing UI.
  // Conversation routing and authenticated pipe coverage live in browser-host.test.ts.
  window = new BrowserWindow({ show: false, frame: false, width: 420, height: 260, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  window.webContents.on("render-process-gone", (_event, details) => finish(new Error(`Fixture renderer exited: ${details.reason}`)));
  await window.loadFile(page);
  host = new DesktopBrowserHost(async () => ({ workspacePath: workspace }));
  const signal = new AbortController().signal;
  const contents = window.webContents;
  contents.setBackgroundThrottling(false);
  stage = "wait for offscreen browser paint";
  await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  stage = "native viewport capture";
  const viewport = await host.screenshot(contents, false, signal);
  stage = "full page capture";
  const fullPage = await host.screenshot(contents, true, signal);
  finish(undefined, {
    viewport: imageObservation(viewport), fullPage: imageObservation(fullPage),
    visible: window.isVisible(), url: pathToFileURL(page).href, offscreen: contents.isOffscreen(),
  });
}).catch(finish);
