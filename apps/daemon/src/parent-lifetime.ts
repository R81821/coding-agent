/** Desktop daemons belong to Electron, not to the pnpm/tsx wrapper that launches them. */
export function watchParentLifetime(parent: string | undefined, onExit: () => void): () => void {
  if (parent === undefined) return () => {}; // Standalone daemon has no desktop owner.
  const pid = Number(parent);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error("Invalid HARNESS_DESKTOP_PID");
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  const check = () => {
    if (stopped) return;
    try { process.kill(pid, 0); }
    catch (error) {
      // EPERM means the process may still exist; never treat it as a dead owner.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      stop();
      onExit();
    }
  };
  check();
  if (!stopped) { timer = setInterval(check, 500); timer.unref(); }
  return stop;
}
