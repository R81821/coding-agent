import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { compareWorkspace, type ExecutionEffect, type WorkspaceSnapshot } from "./workspace-impact.js";

export interface VerificationArtifactCheck {
  cwd?: string | undefined;
  generatedArtifactPaths?: string[] | undefined;
  dependencyPaths?: string[] | undefined;
}

export interface VerificationArtifactComparison {
  effect: ExecutionEffect;
  generatedArtifactPaths: string[];
}

const slash = (value: string) => value.replaceAll("\\", "/");
const mediaExtension = /\.(?:png|jpe?g|webp|gif|pdf)$/i;

function workspacePattern(root: string, value: string, cwd = "."): string | undefined {
  const normalized = slash(value);
  if (!normalized || normalized.includes("\0") || /^(?:\/|[a-z]:)/i.test(normalized) || normalized.split("/").includes("..")) return undefined;
  const path = slash(relative(root, resolve(root, cwd, normalized)));
  return !path || path === ".." || path.startsWith("../") || isAbsolute(path) ? undefined : path;
}

function mediaHeader(path: string, bytes: Buffer): boolean {
  switch (extname(path).toLowerCase()) {
    case ".png": return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case ".jpg": case ".jpeg": return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case ".webp": return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case ".gif": return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
    case ".pdf": return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    default: return false;
  }
}

/**
 * A verification may save explicitly declared new screenshots or reports without editing its
 * source revision. This is deliberately narrower than ignoring an output directory: existing
 * files, executable/text files, declared or analyzed inputs and incomplete coverage still fail.
 * Repeated captures should use a fresh output path or the OS temporary directory.
 */
export async function compareVerificationWorkspace(
  workspacePath: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  checks: VerificationArtifactCheck[],
  dependencies: Record<string, { paths: string[] }> = {},
  signal = new AbortController().signal,
): Promise<VerificationArtifactComparison> {
  const original = compareWorkspace(before, after);
  const unchanged = { effect: original, generatedArtifactPaths: [] };
  if (original.kind !== "repository_write" || !before.complete || !after.complete || before.truncated || after.truncated || before.skipped || after.skipped) return unchanged;
  const root = resolve(workspacePath);
  const outputs = checks.flatMap(check => (check.generatedArtifactPaths ?? []).flatMap(value => {
    const pattern = workspacePattern(root, value, check.cwd);
    // Directory-wide declarations and extension wildcards never authorize source writes.
    return pattern && mediaExtension.test(pattern) ? [pattern] : [];
  }));
  if (!outputs.length) return unchanged;
  const inputs = new Set(Object.values(dependencies).flatMap(dependency => dependency.paths.map(slash)));
  const declaredInputs = checks.flatMap(check => (check.dependencyPaths ?? []).flatMap(value => {
    const pattern = workspacePattern(root, value, check.cwd);
    return pattern ? [pattern] : [];
  }));
  const generatedArtifactPaths: string[] = [];
  for (const path of original.changedFiles) {
    signal.throwIfAborted();
    if (before.files[path] !== undefined || after.files[path] === undefined || !mediaExtension.test(path) || inputs.has(path)
      || declaredInputs.some(pattern => path === pattern || path.startsWith(`${pattern}/`) || matchesGlob(path, pattern))
      || !outputs.some(pattern => matchesGlob(path, pattern))) continue;
    try {
      const absolute = await realpath(resolve(root, path));
      const name = slash(relative(root, absolute));
      if (name !== path) continue;
      const bytes = await readFile(absolute, { signal });
      // Bind classification to the exact bytes in the post-execution snapshot.
      if (mediaHeader(path, bytes) && createHash("sha256").update(bytes).digest("hex") === after.files[path]) generatedArtifactPaths.push(path);
    } catch { signal.throwIfAborted(); }
  }
  const generated = new Set(generatedArtifactPaths);
  const changedFiles = original.changedFiles.filter(path => !generated.has(path));
  return { effect: { kind: changedFiles.length ? "repository_write" : "read", changedFiles }, generatedArtifactPaths };
}
