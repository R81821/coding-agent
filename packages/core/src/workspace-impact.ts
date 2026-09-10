import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@harness/tools";

export interface WorkspaceSnapshot { files: Record<string, string>; complete: boolean; scanned: number; skipped: number; truncated: boolean }
export interface ExecutionEffect { kind: "read" | "probe" | "repository_write" | "unknown"; changedFiles: string[] }
const excluded = new Set([".git", "node_modules", ".cache", ".pnpm-store", ".harness-agent", "dist", "build", "release", ".venv"]);
export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { files: {}, complete: true, scanned: 0, skipped: 0, truncated: false };
  let paths: string[] = [];
  try {
    const git = await runProcess("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], { cwd: root, signal: new AbortController().signal, timeoutMs: 10000, maxOutputBytes: 4_000_000 });
    if (git.exitCode === 0 && !git.truncated) paths = [...new Set(git.stdout.split("\0").filter(Boolean))];
    else {
      const walk = async (directory: string, prefix = "") => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (excluded.has(entry.name)) continue;
          const path = prefix + entry.name;
          if (paths.length >= 20000) { snapshot.complete = false; snapshot.truncated = true; return; }
          if (entry.isDirectory()) await walk(join(directory, entry.name), path + "/");
          else paths.push(path);
        }
      };
      await walk(root);
    }
    if (paths.length > 20000) { snapshot.complete = false; snapshot.truncated = true; paths = paths.slice(0, 20000); }
    // Coverage counters let compareWorkspace tell "the same things were observed" apart from
    // "the observation range changed", so an incomplete snapshot does not become permanently unknown.
    snapshot.scanned = paths.length;
    for (const path of paths.sort()) {
      try {
        const absolute = join(root, path);
        const info = await lstat(absolute);
        if (!info.isFile() || info.size > 64_000_000) { snapshot.complete = false; snapshot.skipped++; continue; }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        snapshot.files[path.replaceAll("\\", "/")] = hash.digest("hex");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { snapshot.complete = false; snapshot.skipped++; } }
    }
  } catch { snapshot.complete = false; }
  return snapshot;
}
export function compareWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ExecutionEffect {
  const changedFiles = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => before.files[path] !== after.files[path]).sort();
  // An observed content difference is a fact: record it as a repository write even when a
  // snapshot was incomplete, otherwise a real edit would never advance the repository revision.
  if (changedFiles.length) return { kind: "repository_write", changedFiles };
  if (before.complete && after.complete) return { kind: "read", changedFiles: [] };
  // Both sides observed the same range (same file count, same skipped count, same truncation
  // state) and saw no difference: treat it as read so large workspaces cannot block on a
  // permanently incomplete snapshot. A changed observation range stays unconfirmed.
  const sameCoverage = before.scanned > 0 && after.scanned > 0 && before.scanned === after.scanned && before.skipped === after.skipped && before.truncated === after.truncated;
  return { kind: sameCoverage ? "read" : "unknown", changedFiles: [] };
}
