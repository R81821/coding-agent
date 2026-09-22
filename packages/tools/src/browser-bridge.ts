import { connect } from "node:net";
import type { BrowserAction } from "@harness/protocol";
import type { ToolContext, ToolResult } from "./types.js";

/** Private local connection to the owning desktop; never a remote debugging port. */
export async function desktopBrowserRequest(endpoint: string, token: string, input: BrowserAction, context: ToolContext): Promise<ToolResult> {
  if (!context.sessionId) throw new Error("内置浏览器需要有效的对话上下文");
  context.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "", done = false;
    const finish = (error?: Error, result?: ToolResult) => {
      if (done) return;
      done = true; clearTimeout(timer); context.signal.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("浏览器操作已取消"));
    const timer = setTimeout(() => finish(new Error("内置浏览器响应超时")), 60_000);
    context.signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ token, sessionId: context.sessionId, runId: context.runId, input }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 24_000_000) return finish(new Error("浏览器返回内容过大"));
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as { ok: boolean; result?: ToolResult; error?: string };
        if (!message.ok || !message.result) finish(new Error(message.error ?? "内置浏览器操作失败")); else finish(undefined, message.result);
      } catch { finish(new Error("内置浏览器返回格式错误")); }
    });
    socket.on("error", () => finish(new Error("无法连接 App 内置浏览器，请确认桌面端仍在运行")));
    socket.on("close", () => { if (!done) finish(new Error("内置浏览器连接已关闭")); });
  });
}
