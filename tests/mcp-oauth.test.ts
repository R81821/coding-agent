import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpStore } from "../packages/extensions/src/mcp-store.js";
import { McpOAuthManager } from "../packages/extensions/src/mcp-oauth.js";
import { connectMcp } from "../packages/extensions/src/mcp-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-oauth-")));
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-oauth-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const store = new McpStore(database);
  const oauth = new McpOAuthManager(database, store);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url)), "oauth"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { await oauth.close(); await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); }); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth fixture did not start")), 5000);
    child.stdout.on("data", data => { clearTimeout(timer); resolve(JSON.parse(data.toString()).url); });
  });
  const view = await store.save({ name: "OAuth", enabled: true, projectPaths: [root], transport: { type: "streamable_http", url } });
  return { root, database, store, oauth, url, view };
}
test("OAuth uses state + PKCE, encrypts credentials, refreshes expired tokens and logs out", async () => {
  const f = await fixture();
  const start = await f.oauth.start(f.view.id);
  const authorization = new URL(start.authorizationUrl!);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("state")!.length).toBeGreaterThan(20);
  const redirect = await fetch(authorization, { redirect: "manual" });
  const callback = new URL(redirect.headers.get("location")!);
  const wrongState = new URL(callback); wrongState.searchParams.set("state", "attacker");
  expect((await fetch(wrongState)).status).toBe(400);
  expect(f.oauth.status(f.view.id).state).toBe("pending");
  expect((await fetch(callback)).status).toBe(200);
  expect(f.oauth.status(f.view.id).state).toBe("authorized");
  const connect = () => connectMcp(f.store.get(f.view.id)!, f.root, new AbortController().signal, { authProvider: f.oauth.provider(f.view.id)! });
  const connection = await connect();
  try { await expect(connection.callTool("echo", {}, new AbortController().signal)).resolves.toHaveProperty("structuredContent"); } finally { await connection.close(); }
  await fetch(new URL("/expire", f.url));
  const refreshed = await connect();
  await refreshed.close();
  expect(await f.oauth.provider(f.view.id)!.tokens()).toMatchObject({ access_token: "fixture-access-secret-2" });
  const persisted = new McpOAuthManager(f.database, f.store);
  expect(persisted.status(f.view.id).state).toBe("authorized");
  const disk = (await readFile(join(f.root, "state.sqlite"))).toString("utf8");
  expect(disk).not.toContain("fixture-access-secret"); expect(disk).not.toContain("fixture-refresh-secret");
  await f.oauth.logout(f.view.id);
  expect(f.oauth.status(f.view.id).state).toBe("signed_out");
  expect(f.oauth.provider(f.view.id)).toBeUndefined();
}, 15_000);
test("changing server URL makes previously captured OAuth providers unusable", async () => {
  const f = await fixture();
  const start = await f.oauth.start(f.view.id);
  const captured = f.oauth.provider(f.view.id)!;
  await f.store.save({ ...f.view, expectedRevision: 1, transport: { type: "streamable_http", url: "https://different.example.test/mcp" } });
  expect(f.oauth.provider(f.view.id)).toBeUndefined();
  await expect(Promise.resolve().then(() => captured.saveTokens({ access_token: "late-token", token_type: "Bearer" }))).rejects.toThrow();
  await f.oauth.logout(f.view.id);
  await expect(fetch(new URL(start.authorizationUrl!).searchParams.get("redirect_uri")!)).rejects.toThrow();
});
