import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PairingService, PluginService, SkillService, isPrivateAddress } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("PairingService hardening", () => {
  it("generates 8-character codes and pairs with a correct code", () => {
    const service = new PairingService();
    const code = service.create("telegram");
    expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(service.pair("telegram", "actor-1", code)).toBe(true);
    expect(service.isPaired("telegram", "actor-1")).toBe(true);
  });

  it("invalidates the code after 5 failed attempts", () => {
    const service = new PairingService();
    const code = service.create("telegram");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(service.pair("telegram", "attacker", "WRONG1")).toBe(false);
    }
    expect(service.pair("telegram", "actor-2", code)).toBe(false);
  });
});

describe("skill draft id validation", () => {
  it("rejects ids that traverse out of the skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-skill-id-"));
    temporary.push(root);
    const service = new SkillService(join(root, "skills"));
    const manifest = {
      id: "../evil",
      name: "Evil",
      version: "1.0.0",
      description: "x",
      triggers: [],
      tools: [],
      pathGlobs: [],
      networkDomains: [],
      compatibility: ">=1.0.0-beta.1",
    };
    await expect(service.draft(manifest, "body")).rejects.toThrow("Invalid skill id");
  });
});

describe("plugin content hashing covers node_modules", () => {
  async function pluginSource(root: string): Promise<string> {
    const source = join(root, "plugin");
    await mkdir(join(source, "node_modules", "dep"), { recursive: true });
    await writeFile(join(source, "harness-plugin.json"), JSON.stringify({
      id: "p1",
      name: "p1",
      version: "1.0.0",
      compatibility: ">=1.0.0",
      entrypoint: "main.js",
      tools: [],
      requestedGrant: { pathGlobs: [], networkDomains: [], allowProcesses: false, mode: "untrusted_docker" },
    }), "utf8");
    await writeFile(join(source, "package.json"), "{}", "utf8");
    await writeFile(join(source, "main.js"), "// plugin", "utf8");
    await writeFile(join(source, "node_modules", "dep", "index.js"), "module.exports = 1", "utf8");
    return source;
  }

  it("detects tampering inside node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plugin-hash-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const source = await pluginSource(root);
    const service = new PluginService(database);
    const before = await service.inspect(source);
    await writeFile(join(source, "node_modules", "dep", "index.js"), "module.exports = 2", "utf8");
    const after = await service.inspect(source);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.fingerprint).toBeDefined();
    database.close();
    vault.dispose();
  });
});

describe("isPrivateAddress", () => {
  it("flags private, loopback, link-local and reserved addresses", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "192.168.1.5", "172.16.0.1", "172.31.255.255", "::1", "fd00::1", "fe80::1", "0.0.0.0"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
