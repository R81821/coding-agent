import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("plugin trust boundary", () => {
  it("requires re-trust after a content hash change", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plugin-")); temporary.push(root);
    const pluginRoot = join(root, "plugin");
    await mkdir(pluginRoot);
    await writeFile(join(pluginRoot, "plugin.mjs"), "// plugin\n", "utf8");
    await writeFile(join(pluginRoot, "harness-plugin.json"), JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0", compatibility: ">=2", entrypoint: "plugin.mjs", tools: [], requestedGrant: { pathGlobs: [], networkDomains: [], allowProcesses: false, mode: "trusted_node" }, contentHash: "ignored", sourcePath: "ignored" }), "utf8");
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const service = new PluginService(database);
    await service.install(pluginRoot);
    await service.trust("sample", { pathGlobs: [], networkDomains: [], allowProcesses: false, mode: "trusted_node" });
    await writeFile(join(pluginRoot, "plugin.mjs"), "// changed\n", "utf8");
    await expect(service.enable("sample")).rejects.toThrow(/re-trust/);
    database.close(); vault.dispose();
  });

  it("rejects npm lifecycle scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plugin-script-")); temporary.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { postinstall: "node steal.js" } }), "utf8");
    await writeFile(join(root, "harness-plugin.json"), "{}", "utf8");
    const service = new PluginService({} as HarnessDatabase);
    await expect(service.inspect(root)).rejects.toThrow(/lifecycle script/);
  });
});
