import { defineConfig } from "tsup";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DesktopBuildPublisher } from "./scripts/atomic-build.js";

// tsup strips the `node:` prefix from built-in imports by default. That is harmless for names which
// also exist unprefixed (`fs`, `path`) but silently breaks the ones that only exist with the prefix
// (`node:sqlite`): the bundle would ask for an npm package named `sqlite`, and both the daemon and
// this main process die while loading persistence. Keep Node's specifiers exactly as written.
const keepNodeProtocol = { removeNodeProtocol: false } as const;

// tsup writes bundles in chunks. Publish complete files separately so an Electron
// startup during a watch rebuild cannot parse a partially written Unicode escape.
const buildId = process.env.HARNESS_DESKTOP_BUILD_ID ?? `${process.pid}-${randomUUID()}`;
const stagingRoot = resolve(".cache/desktop-build", buildId);
const stagingDirectories = { main: resolve(stagingRoot, "main"), preload: resolve(stagingRoot, "preload") };
const publisher = new DesktopBuildPublisher({ buildId, stagingDirectories, outputDirectory: resolve("dist-electron") });
const publishOptions = (part: "main" | "preload") => ({
  outDir: stagingDirectories[part],
  clean: true,
  ignoreWatch: ["dist-electron/**", ".cache/desktop-build/**"],
  plugins: [{ name: `atomic-desktop-${part}`, buildStart() { publisher.started(part); } }],
  onSuccess: () => publisher.completed(part)
});

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    target: "node22",
    ...publishOptions("main"),
    sourcemap: true,
    external: ["electron", "sharp"],
    noExternal: [/^@harness\//],
    ...keepNodeProtocol
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    target: "node22",
    ...publishOptions("preload"),
    sourcemap: true,
    outExtension: () => ({ js: ".cjs" }),
    external: ["electron"],
    ...keepNodeProtocol
  }
]);
