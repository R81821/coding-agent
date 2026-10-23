import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@harness/tools";

export interface WorkspaceSnapshot { files: Record<string, string>; complete: boolean; scanned: number; skipped: number; truncated: boolean }
export interface ExecutionEffect { kind: "read" | "probe" | "repository_write" | "unknown"; changedFiles: string[] }
export const workspaceSnapshotExcludedDirectories = [".git", "node_modules", ".cache", ".pnpm-store", ".harness-agent", "dist", "build", "release", ".venv"] as const;
const excluded = new Set<string>(workspaceSnapshotExcludedDirectories);
export async function snapshotWorkspace(root: string, signal = new AbortController().signal): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { files: Object.create(null) as Record<string, string>, complete: true, scanned: 0, skipped: 0, truncated: false };
  let paths: string[] = [];
  try {
    let git;
    try { git = await runProcess("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], { cwd: root, signal, timeoutMs: 10000, maxOutputBytes: 4_000_000 }); }
    catch { signal.throwIfAborted(); }
    if (git?.exitCode === 0 && !git.truncated) paths = [...new Set(git.stdout.split("\0").filter(Boolean))];
    else {
      const walk = async (directory: string, prefix = "") => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && excluded.has(entry.name)) continue;
          const path = prefix + entry.name;
          if (paths.length >= 20000) { snapshot.complete = false; snapshot.truncated = true; return; }
          if (entry.isDirectory()) await walk(join(directory, entry.name), path + "/");
          else paths.push(path);
        }
      };
      await walk(root);
    }
    if (paths.length > 20000) { snapshot.complete = false; snapshot.truncated = true; paths = paths.slice(0, 20000); }
    // Coverage counters describe the limits of this evidence; incomplete coverage stays unknown.
    snapshot.scanned = paths.length;
    for (const path of paths.sort()) {
      signal.throwIfAborted();
      try {
        const absolute = join(root, path);
        const info = await lstat(absolute);
        if (!info.isFile() || info.size > 64_000_000) { snapshot.complete = false; snapshot.skipped++; continue; }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute, { signal })) hash.update(chunk);
        snapshot.files[path.replaceAll("\\", "/")] = hash.digest("hex");
      } catch { signal.throwIfAborted(); snapshot.complete = false; snapshot.skipped++; }
    }
  } catch { signal.throwIfAborted(); snapshot.complete = false; }
  return snapshot;
}
export function compareWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ExecutionEffect {
  const changedFiles = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => before.files[path] !== after.files[path]).sort();
  // An observed content difference is a fact: record it as a repository write even when a
  // snapshot was incomplete, otherwise a real edit would never advance the repository revision.
  if (changedFiles.length) return { kind: "repository_write", changedFiles };
  if (before.complete && after.complete) return { kind: "read", changedFiles: [] };
  return { kind: "unknown", changedFiles: [] };
}

export function workspaceFingerprint(snapshot: WorkspaceSnapshot): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(snapshot.files).sort(([a],[b]) => a.localeCompare(b)))).digest("hex");
}
