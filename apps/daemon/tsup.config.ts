import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: { js: "import { createRequire as __harnessCreateRequire } from 'node:module'; import { dirname as __harnessDirname } from 'node:path'; import { fileURLToPath as __harnessFileURLToPath } from 'node:url'; const require = __harnessCreateRequire(import.meta.url); const __dirname = __harnessDirname(__harnessFileURLToPath(import.meta.url));" },
  noExternal: [/.*/]
});
