import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "@harness/tools/paths";

export function browserPartition(sessionId: string): string { return "persist:browser-" + createHash("sha256").update(sessionId).digest("hex"); }
export async function browserUploadPaths(workspace: string, paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(async path => {
    const resolved = await confinedPath(workspace, path);
    if (!(await stat(resolved)).isFile()) throw new Error("只能上传工作区内的文件");
    return resolved;
  }));
}
export async function reserveBrowserDownload(workspace: string, filename: string): Promise<string> {
  const dir = await confinedPath(workspace, "downloads", true);
  await mkdir(dir, { recursive: true });
  await confinedPath(workspace, "downloads");
  const name = filename.split(/[\\/]/).at(-1)?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 150) || "download";
  const path = await confinedPath(workspace, join("downloads", `${randomUUID().slice(0, 8)}-${name}`), true);
  const file = await open(path, "wx"); await file.close();
  return path;
}
