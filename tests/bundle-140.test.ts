import { readdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Options } from "tsup";
import { describe, expect, it } from "vitest";
import daemonConfig from "../apps/daemon/tsup.config.js";
import desktopConfig from "../apps/desktop/tsup.config.js";

/**
 * tsup removes the `node:` prefix from built-in imports unless `removeNodeProtocol` is false. Most
 * built-ins also exist unprefixed, so the damage is invisible - but `node:sqlite` does not, and the
 * packaged daemon then asks for an npm package named `sqlite` and dies while loading persistence.
 * The bundle was verified by hand before release; this keeps it from silently coming back.
 */
function options(config: unknown): Options[] {
  return (Array.isArray(config) ? config : [config]) as Options[];
}

function first(entries: Options[], label: string): Options {
  const [entry] = entries;
  if (!entry) throw new Error(`The ${label} tsup config is empty`);
  return entry;
}

const daemonEntries = options(daemonConfig);
const configs = [
  { name: "daemon", entries: daemonEntries },
  { name: "desktop", entries: options(desktopConfig) }
];

describe("production bundles keep Node's own module specifiers", () => {
  it.each(configs)("$name config disables the prefix stripping", ({ entries }) => {
    for (const entry of entries) expect(entry.removeNodeProtocol, JSON.stringify(entry.entry)).toBe(false);
  });

  it("bundling with the daemon config leaves node:sqlite intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-bundle-"));
    try {
      const entryPoint = join(root, "entry.ts");
      await writeFile(entryPoint, 'import { DatabaseSync } from "node:sqlite";\nexport const driver = DatabaseSync;\n');
      await build({ ...first(daemonEntries, "daemon"), entry: { bundle: entryPoint }, outDir: root, clean: false, silent: true });
      const files = (await readdir(root)).filter((name) => name.endsWith(".js"));
      expect(files).not.toHaveLength(0);
      const output = (await Promise.all(files.map((name) => readFile(join(root, name), "utf8")))).join("\n");
      // The stripped form is not resolvable at runtime: `sqlite` is not a built-in name.
      expect(output).toContain('from "node:sqlite"');
      expect(output).not.toMatch(/from\s+"sqlite"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
