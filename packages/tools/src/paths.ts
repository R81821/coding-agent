import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Bound parser work and reject absolute alternatives before passing to glob engines. */
export function validateWorkspaceGlob(pattern: string): void {
  if (pattern.length > 2048 || pattern.includes("..") || /[\\:\x00-\x1f\x7f]/.test(pattern)
      || /(?:^!*)\//.test(pattern) || /[{(,|]\//.test(pattern)) {
    throw new Error("Workspace glob must be a bounded relative pattern without parent traversal");
  }
  let openings = 0;
  let inBrace = false;
  let alternatives = 1;
  let expansions = 1;
  for (const char of pattern) {
    // Count all openings so mismatched closing characters cannot bypass the cap.
    if ("{([".includes(char) && ++openings > 16) throw new Error("Workspace glob is too complex");
    if (char === "{") {
      if (inBrace) throw new Error("Nested braces in workspace globs are too complex");
      inBrace = true;
      alternatives = 1;
    } else if (char === "," && inBrace) {
      if (++alternatives * expansions > 256) throw new Error("Workspace glob has too many expansions");
    } else if (char === "}" && inBrace) {
      expansions *= alternatives;
      inBrace = false;
    }
  }
}

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

