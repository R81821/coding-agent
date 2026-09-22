import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@harness/protocol": `${root}packages/protocol/src/index.ts`,
      "@harness/providers": `${root}packages/providers/src/index.ts`,
      "@harness/persistence": `${root}packages/persistence/src/index.ts`,
      "@harness/tools/paths": `${root}packages/tools/src/paths.ts`,
      "@harness/tools": `${root}packages/tools/src/index.ts`,
      "@harness/extensions": `${root}packages/extensions/src/index.ts`,
      "@harness/core": `${root}packages/core/src/index.ts`,
      "@harness/evals": `${root}packages/evals/src/index.ts`
    }
  },
  test: {
    environment: "node",
    // Vault KDF and real SQLite/process fixtures contend heavily at machine-wide concurrency.
    maxWorkers: 4,
    coverage: { reporter: ["text", "html"] }
  }
});
