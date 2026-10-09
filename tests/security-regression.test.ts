import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "@harness/core";
import { grantsAllow, listFilesTool, searchFilesTool, validateWorkspaceGlob } from "@harness/tools";
import type { PermissionGrant } from "@harness/protocol";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
const grant: PermissionGrant = {
  toolNames: ["terminal"], pathGlobs: [], commandPrefixes: ["npm test"],
  networkDomains: [], maxRisk: "high",
};

describe("command grant escalation", () => {
  it.each([
    "npm test-malicious", "npm test; echo unexpected", "npm test && echo unexpected",
    "npm test | echo unexpected", "npm test\necho unexpected",
    "npm test $(echo unexpected)", "npm test `echo unexpected`", "npm test > outside.txt",
  ])("requires fresh approval for %s", command => {
    expect(new PermissionEngine().decide("terminal", { command }, "high", [grant], tmpdir()).allowed).toBe(false);
    expect(grantsAllow("terminal", [grant], { command }, "high")).toContain("No active grant");
  });

  it("continues to allow ordinary arguments and exactly approved shell syntax", () => {
    expect(new PermissionEngine().decide("terminal", { command: "npm test -- --coverage" }, "high", [grant], tmpdir()).allowed).toBe(true);
    const command = "npm test; echo reviewed";
    expect(grantsAllow("terminal", [{ ...grant, commandPrefixes: [command] }], { command }, "high")).toBeUndefined();
  });

  it("requires approval for a new stdin script even when its interpreter was granted", () => {
    expect(new PermissionEngine().decide("terminal", { command: "node -", stdin: "console.log('new script')" }, "high", [{ ...grant, commandPrefixes: ["node -"] }], tmpdir()).allowed).toBe(false);
  });

  it("fails closed on an invalid grant expiry", () => {
    expect(new PermissionEngine().decide("terminal", { command: "npm test" }, "high", [{ ...grant, expiresAt: "invalid" }], tmpdir()).allowed).toBe(false);
  });
});

describe("workspace glob confinement", () => {
  it.each(["{]".repeat(100) + "a,b" + "}".repeat(100), "{a,b}".repeat(9)])("rejects parser exhaustion pattern %s", glob => {
    expect(() => validateWorkspaceGlob(glob)).toThrow(/glob|complex/i);
  });
  it.each(["/tmp/*", "!//server/share/*", "C:/private/*", "C:private/*", "{/tmp/*,src/*}", "@(/tmp/*|src/*)", "src/../../*"])("rejects nonrelative pattern %s", glob => {
    expect(() => validateWorkspaceGlob(glob)).toThrow();
  });

  it.each(["list_files", "search_files"])("does not enumerate outside directory links in %s", async name => {
    const root = await mkdtemp(join(tmpdir(), "harness-glob-link-"));
    temporary.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "private.txt"), "fixture");
    await symlink(join(root, "outside"), join(workspacePath, "link"), process.platform === "win32" ? "junction" : "dir");
    const tool = name === "list_files" ? listFilesTool : searchFilesTool;
    try {
      const result = await tool.execute({ glob: "link/*.txt", mode: "name" }, { runId: "security", workspacePath, grants: [], signal: new AbortController().signal });
      expect(JSON.stringify(result.output)).not.toContain("private.txt");
    } catch (error) { expect(String(error)).toMatch(/escape|symbolic|link/i); }
  });

  it("preserves normal relative brace globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-glob-positive-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "fixture");
    const result = await listFilesTool.execute({ glob: "src/*.{ts,tsx}" }, { runId: "security", workspacePath: root, grants: [], signal: new AbortController().signal });
    expect(result.output).toEqual(["src/a.ts"]);
  });
  it.each(["list_files", "search_files"])("rejects absolute patterns in %s", async name => {
    const root = await mkdtemp(join(tmpdir(), "harness-glob-security-"));
    temporary.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(root, "private.txt"), "local test fixture");
    const tool = name === "list_files" ? listFilesTool : searchFilesTool;
    const input = { glob: join(root, "*.txt").replaceAll("\\", "/"), mode: "name" };
    await expect(tool.execute(input, { runId: "security", workspacePath, grants: [], signal: new AbortController().signal })).rejects.toThrow(/glob|relative/i);
  });

  it.each(["list_files", "search_files"])("rejects deeply nested brace patterns in %s", async name => {
    const tool = name === "list_files" ? listFilesTool : searchFilesTool;
    await expect(tool.execute({ glob: "{".repeat(100) + "a,b" + "}".repeat(100), mode: "name" }, {
      runId: "security", workspacePath: tmpdir(), grants: [], signal: new AbortController().signal,
    })).rejects.toThrow(/glob|complex/i);
  });
});
