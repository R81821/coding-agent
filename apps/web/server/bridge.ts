import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DaemonRequestSchema,
  DaemonResponseSchema,
  daemonEndpointName,
  type DaemonRequest,
} from "@harness/protocol";

const allowed = new Set([
  "health",
  "projects.list",
  "project.inspect",
  "project.trust",
  "sessions.list",
  "sessions.create",
  "session.get",
  "session.view",
  "run.eventPage",
  "run.output",
  "run.start",
  "run.get",
  "run.events",
  "run.pause",
  "run.resume",
  "run.cancel",
  "run.review",
  "profiles.list",
  "skills.list",
  "plugins.list",
  "approvals.list",
  "approval.decide",
  "plan.get",
  "plan.decide",
]);

export function endpoint(instanceId = process.env.HARNESS_DAEMON_INSTANCE) {
  const name = daemonEndpointName(instanceId);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

export function callDaemon(
  request: DaemonRequest,
  path = endpoint(),
  timeout = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "",
      done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("本地服务响应超时，请检查运行状态。")),
      timeout,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", () =>
      finish(
        new Error("无法连接本地 Harness 服务。请先启动并解锁服务，再重试。"),
      ),
    );
    socket.on("end", () => finish(new Error("本地服务在返回结果前断开连接。")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024)
        return finish(new Error("服务响应过大。"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = DaemonResponseSchema.parse(
          JSON.parse(buffer.slice(0, newline)),
        );
        if (response.id !== request.id)
          throw new Error("服务响应与请求不匹配。");
        if (!response.ok)
          throw new Error(response.error?.message ?? "操作失败");
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("无效响应"));
      }
    });
  });
}

export function isLocalRequest(req: IncomingMessage) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  if (req.headers.origin !== `http://${host}`) return false;
  return (
    req.headers["x-harness-client"] === "web" &&
    req.headers["content-type"]?.split(";")[0] === "application/json"
  );
}

export function createBridge(invoke = callDaemon) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split("?")[0] !== "/api/rpc") return next();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST")
      return send(405, { error: "仅支持 POST 请求。" });
    if (!isLocalRequest(req))
      return send(403, { error: "仅允许本机网页的同源请求。" });
    void (async () => {
      try {
        req.setEncoding("utf8");
        let body = "";
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 1_048_576) return send(413, { error: "请求内容过大。" });
          body += chunk.toString();
        }
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          return send(400, { error: "请求不是有效 JSON。" });
        }
        if (!input || typeof input !== "object" || Array.isArray(input))
          return send(400, { error: "无效请求。" });
        const parsed = DaemonRequestSchema.safeParse({
          ...input,
          id: randomUUID(),
        });
        if (!parsed.success) return send(400, { error: "请求参数无效。" });
        if (!allowed.has(parsed.data.method))
          return send(403, { error: "网页端尚未开放此操作。" });
        send(200, { result: await invoke(parsed.data) });
      } catch (error) {
        send(502, {
          error: error instanceof Error ? error.message : "本地服务不可用。",
        });
      }
    })();
  };
}
