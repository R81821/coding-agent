import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const desktopBuildReadyFilename = ".build-ready.json";
export type DesktopBuildPart = "main" | "preload";

export interface DesktopBuildManifest {
  schemaVersion: 1;
  buildId: string;
  hashes: Record<string, string>;
}

interface BuildPublisherOptions {
  buildId: string;
  outputDirectory: string;
  stagingDirectories: Record<DesktopBuildPart, string>;
}

/** Readers see either the previous complete file or its complete replacement. */
export async function writeFileAtomically(filename: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = join(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    // Never unlink the destination: that would reintroduce the startup read race.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 9 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function checkJavaScript(contents: Buffer, format: "module" | "commonjs"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [`--input-type=${format}`, "--check"], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16_384); });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`Desktop ${format} bundle failed its syntax check: ${diagnostics.trim()}`));
    });
    child.stdin.end(contents);
  });
}

function relocateSourceMap(contents: Buffer, stagingDirectory: string, outputDirectory: string): Buffer {
  const map = JSON.parse(contents.toString("utf8")) as { sources?: unknown; sourceRoot?: string };
  if (!Array.isArray(map.sources) || !map.sources.every(source => typeof source === "string")) throw new Error("Invalid desktop source map");
  if (map.sourceRoot && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(map.sourceRoot)) return contents;
  map.sources = map.sources.map((source: string) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) return source;
    const absolute = isAbsolute(source) ? source : resolve(stagingDirectory, map.sourceRoot ?? "", source);
    return relative(outputDirectory, absolute).replace(/\\/g, "/");
  });
  delete map.sourceRoot;
  return Buffer.from(JSON.stringify(map));
}

/** Coordinate tsup's independent main/preload builds before publishing startup files. */
export class DesktopBuildPublisher {
  private readonly state: Record<DesktopBuildPart, "building" | "ready"> = { main: "building", preload: "building" };
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: BuildPublisherOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.buildId)) throw new Error("Invalid desktop build ID");
  }

  started(part: DesktopBuildPart): void {
    this.state[part] = "building";
    this.generation++;
  }

  async completed(part: DesktopBuildPart): Promise<void> {
    this.state[part] = "ready";
    const publish = this.pending.catch(() => {}).then(() => this.publish());
    this.pending = publish;
    await publish;
  }

  private ready(generation: number): boolean {
    return generation === this.generation && this.state.main === "ready" && this.state.preload === "ready";
  }

  private async publish(): Promise<void> {
    const generation = this.generation;
    if (!this.ready(generation)) return;
    const filenames = ["main.js", "main.js.map", "preload.cjs", "preload.cjs.map"];
    const files = await Promise.all(filenames.map(async filename => {
      const part = filename.startsWith("main.") ? "main" : "preload";
      const contents = await readFile(join(this.options.stagingDirectories[part], filename));
      return {
        filename,
        contents: filename.endsWith(".map")
          ? relocateSourceMap(contents, this.options.stagingDirectories[part], this.options.outputDirectory)
          : contents
      };
    }));
    // A watcher may have begun another build while these files were read.
    if (!this.ready(generation)) return;
    await Promise.all([
      checkJavaScript(files[0]!.contents, "module"),
      checkJavaScript(files[2]!.contents, "commonjs")
    ]);
    if (!this.ready(generation)) return;
    const hashes: Record<string, string> = {};
    for (const file of files) {
      if (!this.ready(generation)) return;
      await writeFileAtomically(join(this.options.outputDirectory, file.filename), file.contents);
      hashes[file.filename] = createHash("sha256").update(file.contents).digest("hex");
    }
    if (!this.ready(generation)) return;
    const manifest: DesktopBuildManifest = { schemaVersion: 1, buildId: this.options.buildId, hashes };
    // Startup waits for this build's marker, which appears only after both bundles and maps.
    await writeFileAtomically(join(this.options.outputDirectory, desktopBuildReadyFilename), JSON.stringify(manifest) + "\n");
  }
}
