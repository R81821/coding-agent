import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { confinedPath } from "./paths.js";
import { grantsAllow } from "./grants.js";
import type { ToolDefinition } from "./types.js";

const MAX_TEXT_BYTES = 1_000_000;
export const FILE_DIFF_MAX_BYTES = 64_000;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inputSchema = z.object({
  path: z.string().min(1).max(4096), content: z.string().max(MAX_TEXT_BYTES),
  overwrite: z.boolean().default(false), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).strict();

/** Truncation is byte bounded and never splits a UTF-8 code point. */
export function boundedFileDiff(diff: string): { diff: string; diffTruncated: boolean } {
  const bytes = Buffer.from(diff);
  if (bytes.length <= FILE_DIFF_MAX_BYTES) return { diff, diffTruncated: false };
  let end = FILE_DIFF_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { diff: bytes.subarray(0, end).toString("utf8"), diffTruncated: true };
}

type Row = { kind: " " | "+" | "-"; token: string };
const tokens = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const rowText = (row: Row) => row.kind + row.token.replace(/\n$/, "") + "\n" + (row.token.endsWith("\n") ? "" : "\\ No newline at end of file\n");

/** Exact line LCS after trimming unchanged ends; large comparisons stay explicitly incomplete. */
export function fileWriteDiff(path: string, before: string, after: string, created: boolean): { diff: string; diffTruncated: boolean; added?: number; deleted?: number } {
  if (before === after && !created) return { diff: "", diffTruncated: false, added: 0, deleted: 0 };
  const oldLines = tokens(before), newLines = tokens(after);
  const headers = `--- ${created ? "/dev/null" : JSON.stringify(`a/${path}`)}\n+++ ${JSON.stringify(`b/${path}`)}\n`;
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix), newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const m = oldMiddle.length, n = newMiddle.length;
  // Do not invent replacement counts if an exact comparison would exceed the work budget.
  if (m && n && ((m + 1) * (n + 1) > 1_000_000 || m + n > 20_000)) return { diff: headers, diffTruncated: true };
  const rows: Row[] = [];
  const contextStart = Math.max(0, prefix - 3);
  for (const token of oldLines.slice(contextStart, prefix)) rows.push({ kind: " ", token });
  let added = 0, deleted = 0;
  let omittedRows = false;
  // A one-sided large addition/deletion can count exactly without retaining every display row.
  if (!m || !n) {
    added = n; deleted = m;
    let bytes = Buffer.byteLength(headers);
    for (const token of m ? oldMiddle : newMiddle) {
      const row: Row = { kind: m ? "-" : "+", token };
      if (bytes > FILE_DIFF_MAX_BYTES) { omittedRows = true; break; }
      rows.push(row); bytes += Buffer.byteLength(rowText(row));
    }
  } else {
    const width = n + 1, table = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) table[i * width + j] = oldMiddle[i] === newMiddle[j]
      ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && oldMiddle[i] === newMiddle[j]) { rows.push({ kind: " ", token: oldMiddle[i++]! }); j++; }
      else if (i < m && (j === n || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { rows.push({ kind: "-", token: oldMiddle[i++]! }); deleted++; }
      else { rows.push({ kind: "+", token: newMiddle[j++]! }); added++; }
    }
  }
  if (!omittedRows) for (const token of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(3, suffix))) rows.push({ kind: " ", token });
  const prefixContext = prefix - contextStart, suffixContext = Math.min(3, suffix);
  const oldCount = prefixContext + m + suffixContext, newCount = prefixContext + n + suffixContext;
  const header = `@@ -${oldCount ? contextStart + 1 : contextStart},${oldCount} +${newCount ? contextStart + 1 : contextStart},${newCount} @@\n`;
  const bounded = boundedFileDiff(headers + header + rows.map(rowText).join(""));
  return { ...bounded, diffTruncated: omittedRows || bounded.diffTruncated, added, deleted };
}

/** Missing ancestors are created one at a time, never through a symbolic link. */
async function checkedTarget(root: string, requested: string, createParents: boolean): Promise<string> {
  if (requested.includes("\0") || /[\r\n]/.test(requested)) throw new Error("File path contains invalid control characters");
  const target = resolve(root, requested), rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("Path escapes the trusted workspace or is the workspace directory");
  let current = root, missing = false;
  for (const segment of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    if (missing && !createParents) continue;
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createParents) { missing = true; continue; }
      try { await mkdir(current); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("File parent must be a real directory inside the workspace");
    await confinedPath(root, relative(root, current));
  }
  if (!missing) {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Only regular files inside the workspace are writable");
      await confinedPath(root, relative(root, target));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

export const writeFileTool: ToolDefinition = {
  contract: {
    name: "write_file", description: "Write a UTF-8 file directly inside the workspace (maximum 1 MB). Creates missing parent directories. New files are exclusive by default; inspect an existing file before setting overwrite=true. Supply expectedSha256 when known to reject stale content. Returns actual write metadata and a bounded unified diff. Prefer patch for small edits to large files.",
    inputSchema: z.toJSONSchema(inputSchema, { io: "input" }), risk: "write", idempotent: false, timeoutMs: 30_000,
  },
  async execute(input, context) {
    let parsed: z.infer<typeof inputSchema>, root: string, target: string, before: Buffer | undefined, mode: number | undefined;
    try {
      parsed = inputSchema.parse(input);
      const denied = grantsAllow("write_file", context.grants, parsed, "write");
      if (denied) throw new Error(denied);
      context.signal.throwIfAborted();
      if (Buffer.byteLength(parsed.content) > MAX_TEXT_BYTES || parsed.content.includes("\0")) throw new Error("write_file supports UTF-8 text up to 1 MB without NUL bytes");
      root = await realpath(context.workspacePath);
      target = await checkedTarget(root, parsed.path, false);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("Only regular files inside the workspace are writable");
        if (!parsed.overwrite) throw new Error("File already exists; inspect it and set overwrite=true to replace it");
        if (info.size > MAX_TEXT_BYTES) throw new Error("Existing file exceeds 1 MB; use patch for a bounded edit");
        before = await readFile(target);
        if (before.includes(0) || !Buffer.from(before.toString("utf8")).equals(before)) throw new Error("Existing file is not UTF-8 text");
        mode = info.mode & 0o777;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (parsed.expectedSha256 && (!before || hash(before) !== parsed.expectedSha256.toLowerCase())) throw new Error("expectedSha256 does not match the current file; refresh the source before writing");
    } catch (error) { return { isError: true, output: { written: false, phase: "validation", error: error instanceof Error ? error.message : String(error) } }; }
    const bytes = Buffer.from(parsed.content), path = relative(root, target).replaceAll("\\", "/"), beforeSha256 = before ? hash(before) : undefined;
    if (before?.equals(bytes)) return { output: { written: true, path, byteLength: bytes.length, created: false, changed: false, sha256: hash(bytes), beforeSha256, diff: "", diffTruncated: false, added: 0, deleted: 0 } };
    let temporary: string | undefined;
    let committed = false;
    try {
      await checkedTarget(root, parsed.path, true);
      context.signal.throwIfAborted();
      temporary = join(dirname(target), `.harness-write-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", mode ?? 0o666);
      try { await handle.writeFile(bytes, { signal: context.signal }); await handle.sync(); } finally { await handle.close(); }
      await checkedTarget(root, parsed.path, false);
      context.signal.throwIfAborted();
      if (before) {
        const current = await readFile(target);
        if (!current.equals(before)) return { isError: true, output: { written: false, phase: "validation", error: "File changed before commit; refresh the source before writing" } };
        await rename(temporary, target);
      } else await link(temporary, target); // Exclusive creation cannot overwrite a concurrently created file.
      committed = true;
      return { output: { written: true, path, byteLength: bytes.length, created: before === undefined, changed: true, sha256: hash(bytes), ...(beforeSha256 ? { beforeSha256 } : {}), ...fileWriteDiff(path, before?.toString("utf8") ?? "", parsed.content, before === undefined) } };
    } catch (error) {
      return { isError: true, output: { written: false, phase: "write", error: error instanceof Error ? error.message : String(error), ...(committed ? { committed: true } : {}) } };
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  },
};
