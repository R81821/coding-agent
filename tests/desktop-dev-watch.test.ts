import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
// @ts-expect-error Development configuration is consumed directly by Node.
import { desktopWatchCommand } from "../apps/desktop/scripts/dev-config.mjs";

const desktopRoot = fileURLToPath(new URL("../apps/desktop", import.meta.url));

it("passes source scopes to tsup's actual CLI without watching dependencies or generated files", async () => {
  // Capture the installed CLI's parsed options in a child process without running a build.
  const script = `
    const { dirname, join } = require("node:path");
    const tsup = require("tsup");
    tsup.build = async options => process.stdout.write(JSON.stringify(options.watch));
    process.argv = [process.execPath, "tsup", ...process.argv.slice(1)];
    require(join(dirname(require.resolve("tsup")), "cli-default.js"));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script, "--", ...desktopWatchCommand.split(" ").slice(1)], { cwd: desktopRoot });
  const scopes: unknown = JSON.parse(stdout);
  expect(Array.isArray(scopes)).toBe(true);
  if (!Array.isArray(scopes)) throw new Error("tsup must receive explicit watch paths");
  const roots = scopes.map(scope => resolve(desktopRoot, scope));
  const watched = (file: string) => roots.some(root => {
    const delta = relative(root, resolve(desktopRoot, file));
    return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
  });
  for (const file of ["src/main.ts", "src/preload.ts", "../../packages/persistence/src/database.ts", "../../packages/protocol/src/index.ts", "../../packages/tools/src/paths.ts"]) {
    expect(watched(file), file).toBe(true);
  }
  for (const file of ["node_modules", "../../node_modules", "release", "dist", "dist-electron", ".cache/desktop-build", "../../packages/tools/dist"]) {
    expect(watched(file), file).toBe(false);
  }
});
