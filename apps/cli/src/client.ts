import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonRequest, DaemonRequestInput } from "@harness/protocol";
import { DaemonResponseSchema, newId } from "@harness/protocol";

export const PIPE_PATH = process.platform === "win32" ? "\\\\.\\pipe\\harness-agent-v2" : join(tmpdir(), "harness-agent-v2.sock");

export async function daemonRequest<T = unknown>(request: DaemonRequestInput & { id?: string }, timeoutMs = 15_000): Promise<T> {
  const payload = { ...request, id: request.id ?? newId("request") } as DaemonRequest;
  return new Promise<T>((resolve, reject) => {
    const socket = connect(PIPE_PATH);
    socket.setEncoding("utf8");
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Daemon request timed out"));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = DaemonResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (!response.ok) reject(new Error(response.error?.message ?? "Daemon request failed"));
        else resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot connect to Harness Agent daemon at ${PIPE_PATH}: ${error.message}`));
    });
  });
}
