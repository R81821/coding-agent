import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { fullPageScreenshotClip } from "./browser-screenshot.js";

interface PendingCommand { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

export class IsolatedBrowser {
  private process?: ChildProcess;
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();

  async start(profilePath: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const executable = findBrowserExecutable();
    if (!executable) throw new Error("Microsoft Edge or Google Chrome was not found; set HARNESS_BROWSER_EXECUTABLE");
    const port = await freePort();
    this.process = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "about:blank"
    ], { windowsHide: true, stdio: "ignore" });
    process.once("exit", () => this.process?.kill());
    let endpoint: string | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        endpoint = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
        if (endpoint) break;
      } catch { /* wait for browser */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!endpoint) throw new Error("Isolated browser did not expose a DevTools endpoint");
    await this.connect(endpoint);
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.send("Page.navigate", { url });
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    return this.snapshotMetadata();
  }

  async snapshot(): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const result = await this.evaluate("({url: location.href, title: document.title, text: (document.body?.innerText || '')})");
    const value = (result as { result?: { value?: { url?: string; title?: string; text?: string } } }).result?.value ?? {};
    const text = String(value.text ?? "");
    return { url: String(value.url ?? ""), title: String(value.title ?? ""), text: text.slice(0, 200_000), truncated: text.length > 200_000 };
  }

  async click(selector: string): Promise<void> {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Selector not found'); el.click(); return true; })()`;
    await this.evaluate(expression, true);
  }

  async fill(selector: string, value: string): Promise<void> {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Selector not found'); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;
    await this.evaluate(expression, true);
  }

  async screenshot(fullPage = false): Promise<string> {
    const clip = fullPage ? fullPageScreenshotClip((await this.send("Page.getLayoutMetrics")).cssContentSize) : undefined;
    const result = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    return String(result.data ?? "");
  }

  metadata(): Promise<{ url: string; title: string }> { return this.snapshotMetadata(); }

  private async snapshotMetadata(): Promise<{ url: string; title: string }> {
    const result = await this.evaluate("({url: location.href, title: document.title})");
    const value = (result as { result?: { value?: { url?: string; title?: string } } }).result?.value ?? {};
    return { url: String(value.url ?? ""), title: String(value.title ?? "") };
  }

  private evaluate(expression: string, awaitPromise = false): Promise<any> {
    return this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Browser CDP connection is not open");
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve: resolveCommand, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private async connect(endpoint: string): Promise<void> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Failed to connect to browser DevTools")), { once: true });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket = socket;
  }
}

function findBrowserExecutable(): string | undefined {
  if (process.env.HARNESS_BROWSER_EXECUTABLE && existsSync(process.env.HARNESS_BROWSER_EXECUTABLE)) return process.env.HARNESS_BROWSER_EXECUTABLE;
  if (process.platform !== "win32") return undefined;
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  return [
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
  ].find(existsSync);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolvePort(port) : reject(new Error("Could not allocate browser debug port")));
    });
  });
}

