import { createServer } from "node:http";
import { createServer as createPipeServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callDaemon, createBridge } from "../server/bridge";
import type { DaemonRequest } from "@harness/protocol";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const invoke = vi.fn(async (_request: DaemonRequest) => ({ status: "ok" }));
  const bridge = createBridge(invoke);
  const server = createServer((req, res) =>
    bridge(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Harness-Client": "web",
  };
  return { invoke, origin, headers };
}
describe("local web bridge", () => {
  it("forwards validated same-origin RPC with a server-generated ID", async () => {
    const { invoke, origin, headers } = await fixture();
    const response = await fetch(`${origin}/api/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "untrusted-id", method: "health" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { status: "ok" } });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ method: "health" });
    expect(
      (invoke.mock.calls[0]?.[0] as unknown as { id: string }).id,
    ).not.toBe("untrusted-id");
  });
  it("rejects cross-origin requests and missing browser headers before dispatch", async () => {
    const { invoke, origin, headers } = await fixture();
    for (const changed of [
      { ...headers, Origin: "https://untrusted.example" },
      { ...headers, "X-Harness-Client": "" },
      { ...headers, Origin: "" },
      {
        ...headers,
        Host: "attacker.example:5180",
        Origin: "http://attacker.example:5180",
      },
    ]) {
      expect(
        (
          await fetch(`${origin}/api/rpc`, {
            method: "POST",
            headers: changed,
            body: '{"method":"health"}',
          })
        ).status,
      ).toBe(403);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("rejects invalid input, unavailable methods, and oversized bodies", async () => {
    const { invoke, origin, headers } = await fixture();
    for (const [body, status] of [
      ["{", 400],
      ['{"method":"run.start","params":{}}', 400],
      ['{"method":"session.purge","params":{"sessionId":"s"}}', 403],
      ["x".repeat(1_048_577), 413],
    ] as const) {
      expect(
        (await fetch(`${origin}/api/rpc`, { method: "POST", headers, body }))
          .status,
      ).toBe(status);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("reports a daemon failure without pretending that an action succeeded", async () => {
    const { invoke, origin, headers } = await fixture();
    invoke.mockRejectedValueOnce(new Error("服务断开"));
    const response = await fetch(`${origin}/api/rpc`, {
      method: "POST",
      headers,
      body: '{"method":"health"}',
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "服务断开" });
  });
  it("reads a split UTF-8 daemon response and checks its request ID", async () => {
    const name = `harness-web-test-${randomUUID()}`;
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : join(tmpdir(), `${name}.sock`);
    const server = createPipeServer((socket) => {
      socket.once("data", () => {
        const body = Buffer.from(
          '{"id":"request-1","ok":true,"result":"运行中"}\n',
        );
        socket.write(body.subarray(0, body.length - 8));
        setTimeout(() => socket.end(body.subarray(body.length - 8)), 10);
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    expect(
      await callDaemon({ id: "request-1", method: "health" }, endpoint),
    ).toBe("运行中");
    await expect(
      callDaemon({ id: "different", method: "health" }, endpoint),
    ).rejects.toThrow("不匹配");
  });
  it("bounds a stalled local service with a timeout", async () => {
    const name = `harness-web-timeout-${randomUUID()}`;
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : join(tmpdir(), `${name}.sock`);
    const server = createPipeServer((socket) => socket.resume());
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await expect(
      callDaemon({ id: "timeout", method: "health" }, endpoint, 20),
    ).rejects.toThrow("超时");
  });
});
