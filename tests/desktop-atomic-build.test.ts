import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopBuildPublisher, desktopBuildReadyFilename, writeFileAtomically, type DesktopBuildManifest } from "../apps/desktop/scripts/atomic-build.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-atomic-build-test-"));
  roots.push(root);
  const outputDirectory = join(root, "dist-electron");
  const stagingDirectories = { main: join(root, "stage", "main"), preload: join(root, "stage", "preload") };
  await Promise.all(Object.values(stagingDirectories).map(directory => mkdir(directory, { recursive: true })));
  const publisher = new DesktopBuildPublisher({ buildId: "fixture-build", outputDirectory, stagingDirectories });
  async function stage(part: "main" | "preload", value: number) {
    const filename = part === "main" ? "main.js" : "preload.cjs";
    const contents = part === "main" ? `export const version = ${value};\n` : `module.exports = ${value};\n`;
    await writeFile(join(stagingDirectories[part], filename), contents);
    await writeFile(join(stagingDirectories[part], `${filename}.map`), JSON.stringify({ version: 3, sources: [`../../src/${part}.ts`], sourcesContent: ["original source"], names: [], mappings: "" }));
  }
  await Promise.all([stage("main", 1), stage("preload", 1)]);
  const manifest = async () => JSON.parse(await readFile(join(outputDirectory, desktopBuildReadyFilename), "utf8")) as DesktopBuildManifest;
  return { root, publisher, outputDirectory, stagingDirectories, stage, manifest };
}

describe("desktop build publication", () => {
  it("waits for both successful configurations and publishes verified hashes", async () => {
    const f = await fixture();
    f.publisher.started("main");
    f.publisher.started("preload");
    await f.publisher.completed("main");
    await expect(readFile(join(f.outputDirectory, "main.js"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.publisher.completed("preload");
    const manifest = await f.manifest();
    expect(manifest.buildId).toBe("fixture-build");
    expect(Object.keys(manifest.hashes).sort()).toEqual(["main.js", "main.js.map", "preload.cjs", "preload.cjs.map"].sort());
    for (const [filename, hash] of Object.entries(manifest.hashes)) expect(createHash("sha256").update(await readFile(join(f.outputDirectory, filename))).digest("hex")).toBe(hash);
    const map = JSON.parse(await readFile(join(f.outputDirectory, "main.js.map"), "utf8"));
    expect(resolve(f.outputDirectory, map.sources[0])).toBe(join(f.root, "src", "main.ts"));
    expect(map.sourcesContent).toEqual(["original source"]);
  });

  it("keeps the previous build when either watch configuration fails, then recovers", async () => {
    const f = await fixture();
    await f.publisher.completed("main");
    await f.publisher.completed("preload");
    const before = await f.manifest();
    f.publisher.started("main");
    f.publisher.started("preload");
    await f.stage("main", 2);
    await f.publisher.completed("main");
    expect(await f.manifest()).toEqual(before);
    expect(await readFile(join(f.outputDirectory, "main.js"), "utf8")).toContain("version = 1");
    await f.stage("preload", 2);
    await f.publisher.completed("preload");
    expect(await readFile(join(f.outputDirectory, "main.js"), "utf8")).toContain("version = 2");
    expect(await readFile(join(f.outputDirectory, "preload.cjs"), "utf8")).toContain("exports = 2");
  });

  it("rejects truncated Unicode escapes before changing any published files", async () => {
    const f = await fixture();
    await f.publisher.completed("main");
    await f.publisher.completed("preload");
    const before = await f.manifest();
    f.publisher.started("main");
    await writeFile(join(f.stagingDirectories.main, "main.js"), "export const broken = '\\u0BA");
    await expect(f.publisher.completed("main")).rejects.toThrow("Invalid Unicode escape sequence");
    expect(await f.manifest()).toEqual(before);
    expect(await readFile(join(f.outputDirectory, "main.js"), "utf8")).toContain("version = 1");
    await f.stage("main", 3);
    f.publisher.started("main");
    await f.publisher.completed("main");
    expect(await readFile(join(f.outputDirectory, "main.js"), "utf8")).toContain("version = 3");
  });

  it("serializes overlapping completions and publishes a dependency-only update", async () => {
    const f = await fixture();
    await Promise.all([f.publisher.completed("main"), f.publisher.completed("preload")]);
    f.publisher.started("main");
    await f.stage("main", 4);
    await f.publisher.completed("main");
    expect(await readFile(join(f.outputDirectory, "main.js"), "utf8")).toContain("version = 4");
    expect(await readFile(join(f.outputDirectory, "preload.cjs"), "utf8")).toContain("exports = 1");
    expect(await readdir(f.outputDirectory)).not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it("never exposes a partially written 1 MiB bundle to concurrent readers", async () => {
    const f = await fixture();
    const filename = join(f.outputDirectory, "main.js");
    const first = Buffer.alloc(1_048_576, "a");
    const second = Buffer.alloc(1_048_576, "b");
    await writeFileAtomically(filename, first);
    let finished = false;
    let samples = 0;
    const reader = (async () => {
      while (!finished) {
        const contents = await readFile(filename);
        expect(contents.length).toBe(first.length);
        expect(contents.equals(first) || contents.equals(second)).toBe(true);
        samples++;
        // Windows can deny replacement while a reader holds the destination open.
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })();
    try { for (let index = 0; index < 25; index++) await writeFileAtomically(filename, index % 2 ? first : second); }
    finally { finished = true; await reader; }
    expect(samples).toBeGreaterThan(0);
    expect((await readdir(f.outputDirectory)).filter(filename => filename.endsWith(".tmp"))).toEqual([]);
  });
});
