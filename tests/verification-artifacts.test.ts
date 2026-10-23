import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVerificationWorkspace } from "../packages/core/src/verification-artifacts.js";
import { compareWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from "../packages/core/src/workspace-impact.js";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
const check = { cwd: ".", generatedArtifactPaths: ["screenshots/*.png"] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-verification-artifacts-"));
  roots.push(root);
  await writeFile(join(root, "app.ts"), "export const value = 1;\n");
  const save = async (path: string, content: string | Buffer = png) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return { root, save, before: await snapshotWorkspace(root) };
}

describe("verification generated artifact classification", () => {
  it("accepts a declared newly saved screenshot without changing ordinary repository write detection", async () => {
    const f = await fixture();
    await f.save("screenshots/dashboard-1440.png");
    const after = await snapshotWorkspace(f.root);
    expect(compareWorkspace(f.before, after)).toEqual({ kind: "repository_write", changedFiles: ["screenshots/dashboard-1440.png"] });
    expect(await compareVerificationWorkspace(f.root, f.before, after, [check])).toEqual({
      effect: { kind: "read", changedFiles: [] }, generatedArtifactPaths: ["screenshots/dashboard-1440.png"],
    });
    expect(await readFile(join(f.root, "screenshots/dashboard-1440.png"))).toEqual(png);
  });

  it("keeps genuine source modifications invalid even when a screenshot was also saved", async () => {
    const f = await fixture();
    await f.save("screenshots/dashboard.png");
    await f.save("app.ts", "export const value = 2;\n");
    expect(await compareVerificationWorkspace(f.root, f.before, await snapshotWorkspace(f.root), [check])).toEqual({
      effect: { kind: "repository_write", changedFiles: ["app.ts"] }, generatedArtifactPaths: ["screenshots/dashboard.png"],
    });
  });

  it.each(["screenshots/source.ts", "screenshots/data.json", "screenshots/config.js", "screenshots/fake.png"])("never hides source or disguised text at %s", async path => {
    const f = await fixture();
    await f.save(path, "export const hidden = true;\n");
    const result = await compareVerificationWorkspace(f.root, f.before, await snapshotWorkspace(f.root), [{ generatedArtifactPaths: ["screenshots/**", path] }]);
    expect(result).toEqual({ effect: { kind: "repository_write", changedFiles: [path] }, generatedArtifactPaths: [] });
  });

  it("requires an explicit matching path and resolves it relative to the check cwd", async () => {
    const f = await fixture();
    await f.save("client/screenshots/dashboard.png");
    const after = await snapshotWorkspace(f.root);
    expect((await compareVerificationWorkspace(f.root, f.before, after, [check])).effect.kind).toBe("repository_write");
    expect((await compareVerificationWorkspace(f.root, f.before, after, [{ ...check, cwd: "client" }])).effect.kind).toBe("read");
    expect((await compareVerificationWorkspace(f.root, f.before, after, [{ generatedArtifactPaths: ["../client/screenshots/*.png", "C:/outside/*.png", "/client/screenshots/*.png"] }])).effect.kind).toBe("repository_write");
  });

  it("keeps input images protected by analyzed dependencies or explicit input globs", async () => {
    const f = await fixture();
    const path = "screenshots/reference.png";
    await f.save(path);
    const after = await snapshotWorkspace(f.root);
    expect((await compareVerificationWorkspace(f.root, f.before, after, [check], { test: { paths: [path] } })).effect.kind).toBe("repository_write");
    expect((await compareVerificationWorkspace(f.root, f.before, after, [{ ...check, dependencyPaths: ["screenshots/*.png"] }])).effect.kind).toBe("repository_write");
    expect((await compareVerificationWorkspace(f.root, f.before, after, [{ ...check, dependencyPaths: ["screenshots"] }])).effect.kind).toBe("repository_write");
  });

  it("does not exempt overwrites or deletions of existing image inputs", async () => {
    const f = await fixture();
    const path = "screenshots/reference.png";
    await f.save(path);
    const before = await snapshotWorkspace(f.root);
    await f.save(path, Buffer.concat([png, Buffer.from("changed")]));
    expect((await compareVerificationWorkspace(f.root, before, await snapshotWorkspace(f.root), [check])).effect.kind).toBe("repository_write");
    await rm(join(f.root, path));
    expect((await compareVerificationWorkspace(f.root, before, await snapshotWorkspace(f.root), [check])).effect.kind).toBe("repository_write");
  });

  it.each(["complete", "truncated", "skipped"])("preserves incomplete coverage when the %s field indicates it", async field => {
    const f = await fixture();
    await f.save("screenshots/dashboard.png");
    const after = await snapshotWorkspace(f.root);
    const incomplete: WorkspaceSnapshot = { ...after, [field]: field === "complete" ? false : field === "skipped" ? 1 : true };
    expect((await compareVerificationWorkspace(f.root, f.before, incomplete, [check])).effect.kind).toBe("repository_write");
  });

  it("binds the media header to the bytes that were snapshotted", async () => {
    const f = await fixture();
    await f.save("screenshots/dashboard.png");
    const after = await snapshotWorkspace(f.root);
    await f.save("screenshots/dashboard.png", Buffer.concat([png, Buffer.from("race")]));
    expect((await compareVerificationWorkspace(f.root, f.before, after, [check])).effect.kind).toBe("repository_write");
  });
});
