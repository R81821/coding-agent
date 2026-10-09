import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { PluginService, isPrivateAddress } from "@harness/extensions";
import type { HarnessDatabase } from "@harness/persistence";
import type { PluginGrant } from "@harness/protocol";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const grant: PluginGrant = { pathGlobs: ["allowed"], networkDomains: ["127.0.0.1"], allowProcesses: false, mode: "untrusted_docker" };
const service = () => new PluginService({} as HarnessDatabase);

describe("plugin broker isolation", () => {
  it("rejects a junction from a granted directory into an ungranted directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plugin-security-"));
    roots.push(root);
    await mkdir(join(root, "allowed"));
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private", "secret.txt"), "fixture secret");
    await writeFile(join(root, "allowed", "public.txt"), "allowed fixture");
    await expect(service()["broker"]({ operation: "fs.read", path: "allowed/public.txt" }, grant, root, new AbortController().signal)).resolves.toEqual({ text: "allowed fixture" });
    await symlink(join(root, "private"), join(root, "allowed", "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(service()["broker"]({ operation: "fs.read", path: "allowed/link/secret.txt" }, grant, root, new AbortController().signal)).rejects.toThrow(/denied|escape/i);
  });

  it("bounds responses from an explicitly granted local IP", async () => {
    const server = createServer((_request, response) => response.end("x".repeat(1_100_000)));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const result = await service()["broker"]({ operation: "net.fetch", url }, grant, tmpdir(), new AbortController().signal);
    expect(result).toEqual({ status: 200, body: "x".repeat(1_000_000) });
  });

  it("rejects hostname resolution into loopback before sending HTTP", async () => {
    let hits = 0;
    const server = createServer((_request, response) => { hits++; response.end("private"); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as { port: number }).port}/`;
    await expect(service()["broker"]({ operation: "net.fetch", url }, { ...grant, networkDomains: ["localhost"] }, tmpdir(), new AbortController().signal)).rejects.toThrow("non-public");
    expect(hits).toBe(0);
  });

  it("does not follow a redirect to a domain outside the grant", async () => {
    let targetHits = 0;
    const server = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: `http://localhost:${(server.address() as { port: number }).port}/private` });
        response.end();
      } else { targetHits++; response.end("fixture secret"); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/start`;
    await expect(service()["broker"]({ operation: "net.fetch", url }, grant, tmpdir(), new AbortController().signal)).rejects.toThrow(/redirect/i);
    expect(targetHits).toBe(0);
  });

  it.each(["::ffff:192.168.1.1", "::ffff:c0a8:101", "::ffff:10.0.0.1", "fe90::1", "ff02::1", "224.0.0.1"])("rejects non-public address %s", address => {
    expect(isPrivateAddress(address)).toBe(true);
  });
});
