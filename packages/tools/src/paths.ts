import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export async function confinedPath(workspacePath: string, requestedPath: string, allowMissing = false): Promise<string> {
  const workspace = await realpath(workspacePath);
  const candidate = resolve(workspace, requestedPath);
  assertWithin(workspace, candidate);
  try {
    const resolved = await realpath(candidate);
    assertWithin(workspace, resolved);
    return resolved;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(candidate));
    assertWithin(workspace, parent);
    return candidate;
  }
}

function assertWithin(workspace: string, candidate: string): void {
  const rel = relative(workspace, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`Path escapes the trusted workspace: ${candidate}`);
}

export async function rejectSymlink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Symbolic link targets are not writable: ${path}`);
}

