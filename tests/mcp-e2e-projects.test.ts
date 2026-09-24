import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { McpService, McpStore } from "@harness/extensions";
import { DEFAULT_PROFILE, newId, nowIso, type RunSpec } from "@harness/protocol";
import { prepareMcpCapabilities } from "../packages/core/src/mcp-capabilities.js";

const serverFile = fileURLToPath(new URL("../packages/extensions/test-fixtures/mcp-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("A/B projects keep separate roots while an unbound project receives no tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-mcp-e2e-")));
  const a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)]);
  const vault = await VaultCrypto.open(join(root, "key.json"), "mcp-e2e-fixture-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  const mcp = new McpService(new McpStore(database));
  cleanups.push(async () => { await mcp.close(); database.close(); vault.dispose(); await rm(root, { recursive: true, force: true }); });
  await mcp.save({ name: "Project service", enabled: true, projectPaths: [a, b], readOnlyTools: ["echo"], transport: { type: "stdio", command: process.execPath, args: [serverFile] } });
  const specFor = (workspacePath: string): RunSpec => ({ id: newId("run"), sessionId: "session", profileId: "default", workspacePath, request: "status", attachments: [], grants: [], budget: { ...DEFAULT_PROFILE.budget, maxTurns: 4 }, createdAt: nowIso() });

  const leaseA = await prepareMcpCapabilities(mcp, specFor(a), new AbortController().signal);
  const leaseB = await prepareMcpCapabilities(mcp, specFor(b), new AbortController().signal);
  const leaseC = await prepareMcpCapabilities(mcp, specFor(c), new AbortController().signal);
  try {
    expect(leaseA.snapshot).toHaveLength(4);
    expect(leaseB.snapshot).toHaveLength(4);
    expect(leaseC.snapshot).toHaveLength(0);
    expect(leaseC.tools).toEqual([]);
    // Empty diagnostics prove C was filtered out by project binding, not a swallowed connection failure.
    expect(leaseC.diagnostics).toEqual([]);

    const call = async (lease: typeof leaseA, workspacePath: string) => {
      const tool = lease.tools.find(candidate => candidate.external?.toolName === "echo")!;
      const result = await tool.execute({ value: "roots-check" }, { runId: "run", workspacePath, grants: [], signal: new AbortController().signal });
      return (result.output as { structuredContent?: { cwd?: string; roots?: Array<{ uri: string }> } }).structuredContent;
    };
    expect(await call(leaseA, a)).toMatchObject({ cwd: a, roots: [{ uri: pathToFileURL(a).href }] });
    expect(await call(leaseB, b)).toMatchObject({ cwd: b, roots: [{ uri: pathToFileURL(b).href }] });
  } finally {
    await leaseA.close(); await leaseB.close(); await leaseC.close();
  }
});
