// Watch source files directly. Watching "." makes tsup enumerate dependencies,
// release artifacts and build caches before it can finish publishing the bundles.
export const desktopWatchPaths = [
  "src",
  "scripts/atomic-build.ts",
  "tsup.config.ts",
  "package.json",
  "../../packages/persistence/src",
  "../../packages/protocol/src",
  "../../packages/tools/src",
];
export const desktopWatchCommand = `tsup ${desktopWatchPaths.map(path => `--watch ${path}`).join(" ")}`;

export function desktopDevelopmentServer(environment = process.env) {
  const value = environment.HARNESS_DESKTOP_DEV_PORT ?? "5173";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("HARNESS_DESKTOP_DEV_PORT must be an integer between 1 and 65535");
  }
  const port = Number(value);
  return { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` };
}
