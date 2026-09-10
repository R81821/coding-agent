import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "@harness/protocol";
import packageInfo from "../../../package.json";

export const AGENT_VERSION = packageInfo.version;
export function promptCacheKey(version: string, repoId: string): string {
  return version.slice(0, 24) + ":" + createHash("sha256").update(repoId).digest("hex").slice(0, 32);
}
export async function repositoryBaseSnapshot(workspacePath: string) {
  const canonicalPath = await realpath(workspacePath).catch(() => resolve(workspacePath));
  const identity = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const repoId = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const excluded = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "target"]);
  const entries = (await readdir(canonicalPath, { withFileTypes: true }).catch(() => []))
    .filter(entry => !excluded.has(entry.name)).map(entry => entry.name + (entry.isDirectory() ? "/" : "")).sort();
  return { repoId, workspacePath: canonicalPath, entries: entries.slice(0, 200), truncated: entries.length > 200 };
}
export type ContextDiff = { op: "set" | "remove" | "append"; path: string[]; value?: unknown };
export interface ContextFrame { kind: "base_snapshot" | "dirty_diff"; baseId: string; snapshot?: unknown; dirtyDiff?: ContextDiff[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function diff(before: unknown, after: unknown, path: string[] = []): ContextDiff[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length && before.every((item, i) => canonicalJson(item) === canonicalJson(after[i]))) return [{ op: "append", path, value: after.slice(before.length) }];
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => !(key in after) ? [{ op: "remove" as const, path: [...path, key] }] : diff(before[key], after[key], [...path, key]));
  return [{ op: "set", path, value: after }];
}
export function applyContextDiff(snapshot: unknown, changes: ContextDiff[]): unknown {
  let result = structuredClone(snapshot);
  for (const change of changes) {
    if (change.path.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Unsafe context path");
    if (!change.path.length) { result = structuredClone(change.value); continue; }
    let parent = result as Record<string, unknown>;
    for (const key of change.path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = change.path.at(-1)!;
    if (change.op === "remove") delete parent[key];
    else parent[key] = change.op === "append" ? [...parent[key] as unknown[], ...structuredClone(change.value) as unknown[]] : structuredClone(change.value);
  }
  return result;
}
export class RuntimeContextDelta {
  private previous: unknown;
  private baseId = "";
  update(snapshot: unknown): ContextFrame | undefined {
    const serialized = canonicalJson(snapshot);
    if (!this.baseId) {
      this.baseId = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
      this.previous = JSON.parse(serialized);
      return { kind: "base_snapshot", baseId: this.baseId, snapshot: this.previous };
    }
    const dirtyDiff = diff(this.previous, snapshot);
    this.previous = JSON.parse(serialized);
    return dirtyDiff.length ? { kind: "dirty_diff", baseId: this.baseId, dirtyDiff } : undefined;
  }
}
