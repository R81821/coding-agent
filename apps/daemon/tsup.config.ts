import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // tsup strips the `node:` prefix from built-in imports by default, which is harmless for names
  // that also exist unprefixed (`fs`, `path`) but silently breaks the ones that only exist with the
  // prefix (`node:sqlite`): the bundle then asks for an npm package called `sqlite` and the daemon
  // dies while loading persistence. Keep Node's own specifiers exactly as written.
  removeNodeProtocol: false,
  banner: { js: "import { createRequire as __harnessCreateRequire } from 'node:module'; import { dirname as __harnessDirname } from 'node:path'; import { fileURLToPath as __harnessFileURLToPath } from 'node:url'; const require = __harnessCreateRequire(import.meta.url); const __dirname = __harnessDirname(__harnessFileURLToPath(import.meta.url));" },
  noExternal: [/.*/]
});
