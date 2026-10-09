import { spawn, type ChildProcess } from "node:child_process";

/** Wait for the entire Windows launcher tree, not just pnpm's exit event. */
export async function stopDaemonProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || !isProcessAlive(pid)) resolve();
        else reject(new Error("旧 daemon 进程未能退出，请关闭旧的开发终端后重试"));
      });
    });
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("旧 daemon 进程未能在 5 秒内退出，请稍后重试"));
    }, 5_000);
    const exited = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); child.off("exit", exited); };
    child.once("exit", exited);
    if (!child.kill() && !isProcessAlive(pid)) exited();
  });
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
