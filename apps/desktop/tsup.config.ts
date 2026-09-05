import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    target: "node22",
    outDir: "dist-electron",
    clean: true,
    sourcemap: true,
    external: ["electron", "sharp"],
    noExternal: [/^@harness\//]
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    target: "node22",
    outDir: "dist-electron",
    clean: false,
    sourcemap: true,
    outExtension: () => ({ js: ".cjs" }),
    external: ["electron"]
  }
]);
