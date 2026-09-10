import { defineConfig } from "tsup";

// tsup strips the `node:` prefix from built-in imports by default. That is harmless for names which
// also exist unprefixed (`fs`, `path`) but silently breaks the ones that only exist with the prefix
// (`node:sqlite`): the bundle would ask for an npm package named `sqlite`, and both the daemon and
// this main process die while loading persistence. Keep Node's specifiers exactly as written.
const keepNodeProtocol = { removeNodeProtocol: false } as const;

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    target: "node22",
    outDir: "dist-electron",
    clean: true,
    sourcemap: true,
    external: ["electron", "sharp"],
    noExternal: [/^@harness\//],
    ...keepNodeProtocol
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    target: "node22",
    outDir: "dist-electron",
    clean: false,
    sourcemap: true,
    outExtension: () => ({ js: ".cjs" }),
    external: ["electron"],
    ...keepNodeProtocol
  }
]);
