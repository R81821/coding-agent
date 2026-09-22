import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserActionSchema, browserUrl } from "@harness/protocol";
import { PermissionEngine } from "../packages/core/src/security.js";
import { reserveBrowserDownload, browserUploadPaths, browserPartition } from "../apps/desktop/src/browser-files.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("embedded browser boundary", () => {
  it("allows local previews but rejects privileged and credential-bearing URLs", () => {
    expect(browserUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
    for (const url of ["file:///C:/secret", "javascript:alert(1)", "https://user:pass@example.com", "data:text/html,hello"]) expect(() => browserUrl(url)).toThrow();
  });
  it("requires specific upload files and refuses arbitrary JavaScript actions", () => {
    expect(BrowserActionSchema.safeParse({ action: "upload", selector: "input", paths: [] }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "evaluate", code: "process.env" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "tabs", sessionId: "other" }).success).toBe(false);
  });
  it("never converts a previous transfer approval into a reusable transfer grant", () => {
    const engine = new PermissionEngine();
    const grants = [{ toolNames: ["browser"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "high" as const }];
    for (const action of ["upload", "download", "click", "fill"]) expect(engine.decide("browser", { action }, "high", grants, ".").allowed).toBe(false);
    expect(engine.decide("browser", { action: "snapshot" }, "read", [], ".").allowed).toBe(true);
  });
  it("uses distinct persistent website partitions per conversation", () => {
    expect(browserPartition("session-a")).toMatch(/^persist:browser-[a-f0-9]{64}$/);
    expect(browserPartition("session-a")).not.toBe(browserPartition("session-b"));
    expect(browserPartition("../../a")).not.toContain("/");
  });
  it("confines uploads and reserves separate download files without overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-browser-test-")); directories.push(root);
    const workspace = join(root, "project"); await mkdir(workspace);
    await writeFile(join(workspace, "report.txt"), "test"); await writeFile(join(root, "secret.txt"), "secret");
    expect(await browserUploadPaths(workspace, ["report.txt"])).toEqual([join(workspace, "report.txt")]);
    await expect(browserUploadPaths(workspace, ["../secret.txt"])).rejects.toThrow();
    const a = await reserveBrowserDownload(workspace, "../../CON:secret?.txt");
    const b = await reserveBrowserDownload(workspace, "../../CON:secret?.txt");
    expect(a).not.toBe(b); expect(a.startsWith(join(workspace, "downloads") + "\\") || a.startsWith(join(workspace, "downloads") + "/")).toBe(true);
  });
});
