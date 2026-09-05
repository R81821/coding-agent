import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number; stdin?: string; maxOutputBytes?: number }
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: "pipe", detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const append = (current: string, chunk: string): string => {
      if (Buffer.byteLength(current) >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk;
      if (Buffer.byteLength(next) > maxOutputBytes) {
        truncated = true;
        return Buffer.from(next).subarray(0, maxOutputBytes).toString("utf8");
      }
      return next;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = append(stdout, chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const onAbort = () => killTree(child);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr, truncated, timedOut });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** Kill the process and its whole tree; Windows shells spawn grandchildren that a bare kill() leaves orphaned. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
