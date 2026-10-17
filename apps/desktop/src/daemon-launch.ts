import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Launch the source daemon directly so the tracked child also owns the database. */
export function developmentDaemonCommand(workspaceRoot: string): { args: string[]; cwd: string } {
  const cwd = join(workspaceRoot, "apps", "daemon");
  const require = createRequire(join(cwd, "package.json"));
  const loader = pathToFileURL(require.resolve("tsx")).href;
  return { args: ["--import", loader, join(cwd, "src", "main.ts")], cwd };
}
