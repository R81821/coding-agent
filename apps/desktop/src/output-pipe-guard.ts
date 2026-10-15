import type { Writable } from "node:stream";

const guards = new WeakMap<Writable, () => void>();

export function isDisconnectedOutput(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/** A desktop can outlive its launcher. Losing that launcher's log pipe must not terminate the app. */
export function guardOutputPipe(stream: Writable): () => void {
  const installed = guards.get(stream);
  if (installed) return installed;
  const originalWrite = stream.write;
  let disconnected: unknown;
  const onError = (error: Error) => {
    if (!isDisconnectedOutput(error)) throw error;
    disconnected = error;
  };
  const callback = (args: unknown[], error: unknown) => {
    const complete = args.findLast(value => typeof value === "function") as ((error: unknown) => void) | undefined;
    if (complete) queueMicrotask(() => complete(error));
  };
  const write = function (this: Writable, ...args: unknown[]): boolean {
    if (disconnected) { callback(args, disconnected); return false; }
    try { return Reflect.apply(originalWrite, this, args) as boolean; }
    catch (error) {
      if (!isDisconnectedOutput(error)) throw error;
      disconnected = error; callback(args, error); return false;
    }
  } as Writable["write"];
  stream.on("error", onError);
  stream.write = write;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (stream.write === write) stream.write = originalWrite;
    stream.off("error", onError); guards.delete(stream);
  };
  guards.set(stream, restore);
  return restore;
}

export function guardProcessOutput(): void {
  guardOutputPipe(process.stdout);
  guardOutputPipe(process.stderr);
}
