import { spawn, type ChildProcess } from "node:child_process";

const stopping = new WeakMap<ChildProcess, Promise<void>>();

/** Stop once and confirm that the actual database-owning process has exited. */
export function stopDaemonProcess(child: ChildProcess): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  const operation = stopChild(child);
  stopping.set(child, operation);
  void operation.catch(() => stopping.delete(child));
  return operation;
}

async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  let cleanup = () => {};
  let cleanupKiller = () => {};
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("旧 daemon 进程未能在 5 秒内退出，请稍后重试"));
    }, 5_000);
    const onExit = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    cleanup = () => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); };
    child.once("exit", onExit);
    child.once("error", onError);
  });
  try {
    if (process.platform === "win32") {
      const killed = new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          windowsHide: true, stdio: "ignore",
        });
        const onError = (error: Error) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(error);
        };
        const onClose = (code: number | null) => {
          if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(new Error("旧 daemon 进程未能退出，请关闭旧的开发终端后重试"));
        };
        cleanupKiller = () => { killer.off("error", onError); killer.off("close", onClose); };
        killer.once("error", onError);
        killer.once("close", onClose);
      });
      await Promise.all([killed, exited]);
    } else {
      if (!child.kill() && !isProcessAlive(pid)) return;
      await exited;
    }
  } finally { cleanup(); cleanupKiller(); }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
