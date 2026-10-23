import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import type { AttachmentRef } from "@harness/protocol";
import type { EncryptedBlobStore } from "@harness/persistence";
import { confinedPath, gitDiffTool, runProcess, type ToolDefinition, type ToolResult } from "@harness/tools";
import { snapshotWorkspace, workspaceFingerprint, workspaceSnapshotExcludedDirectories, type WorkspaceSnapshot } from "./workspace-impact.js";

interface FileRecord { hash: string; size: number; binary: boolean; text?: string; textRef?: AttachmentRef }
interface Baseline { version?: 2; root?: string; files: Record<string, FileRecord>; complete: boolean; missingHistory: boolean }
interface DiffEntry {
  path: string;
  status: "added" | "deleted" | "modified";
  before?: { hash: string; size: number; binary: boolean };
  after?: { hash: string; size: number; binary: boolean };
  diff?: string;
  part?: number;
  parts?: number;
  complete: boolean;
  reason?: string;
}
interface DiffSession {
  id: string;
  fingerprint: string;
  entries: DiffEntry[];
  offset: number;
  pagesRead: number;
  complete: boolean;
  changedFiles: number;
  manifestDigest: string;
  nextCursor?: string;
}
const INLINE_TEXT_LIMIT = 64_000;
const INLINE_TOTAL_LIMIT = 384_000;
const MEMORY_TEXT_LIMIT = 64_000_000;
// Keep each result comfortably below the runtime's general output budget, including JSON escaping.
const PAGE_LIMIT = 72_000;
const PART_LIMIT = 8_000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rootIdentity = async (root: string) => {
  const path = (await realpath(root)).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
};

/** Baselines live in the encrypted application blob store, never in the user's directory. */
export class WorkspaceDiff {
  private baseline?: Baseline;
  private git?: boolean;
  private session: DiffSession | undefined;
  reference: AttachmentRef | undefined;
  constructor(private root: string, private blobs?: EncryptedBlobStore, reference?: AttachmentRef, private missingHistory = false) {
    this.reference = reference;
  }
  private async capture(signal: AbortSignal, persistText = false): Promise<Baseline> {
    const snapshot = await snapshotWorkspace(this.root, signal);
    const result: Baseline = { version: 2, root: await rootIdentity(this.root), files: Object.create(null) as Record<string, FileRecord>, complete: snapshot.complete, missingHistory: this.missingHistory };
    let inlineBytes = 0;
    for (const [path, hash] of Object.entries(snapshot.files)) {
      signal.throwIfAborted();
      try {
        const data = await readFile(await confinedPath(this.root, path));
        if (digest(data) !== hash) { result.complete = false; continue; }
        const text = data.toString("utf8");
        const binary = data.includes(0) || !Buffer.from(text).equals(data);
        const record: FileRecord = { hash, size: data.length, binary };
        if (!binary) {
          if (persistText && this.blobs && (data.length > INLINE_TEXT_LIMIT || inlineBytes + data.length > INLINE_TOTAL_LIMIT)) {
            record.textRef = await this.blobs.put({ bytes: data, mimeType: "text/plain", source: "file" });
          } else if (inlineBytes + data.length <= MEMORY_TEXT_LIMIT) {
            record.text = text;
            inlineBytes += data.length;
          }
          // A missing body is never treated as inspected if this file later changes.
        }
        result.files[path] = record;
      } catch { signal.throwIfAborted(); result.complete = false; }
    }
    const after = await snapshotWorkspace(this.root, signal);
    if (!after.complete || workspaceFingerprint(snapshot) !== workspaceFingerprint(after)) result.complete = false;
    return result;
  }
  private async restore(reference: AttachmentRef): Promise<Baseline> {
    if (!this.blobs) throw new Error("Baseline store unavailable");
    const candidate = JSON.parse((await this.blobs.read(reference)).toString("utf8")) as Baseline;
    if (!candidate || typeof candidate !== "object" || !candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files)
      || typeof candidate.complete !== "boolean" || typeof candidate.missingHistory !== "boolean") throw new Error("Invalid workspace baseline");
    if (candidate.version !== undefined && candidate.version !== 2) throw new Error("Unsupported workspace baseline");
    if (candidate.version === 2 && candidate.root !== await rootIdentity(this.root)) throw new Error("Workspace baseline belongs to another root");
    for (const [path, file] of Object.entries(candidate.files)) {
      if (!path || /^(?:[\\/]|[a-z]:)/i.test(path) || path.split(/[\\/]/).some(part => part === "..")
        || !file || typeof file !== "object" || !/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.binary !== "boolean"
        || (file.text !== undefined && (typeof file.text !== "string" || digest(file.text) !== file.hash || Buffer.byteLength(file.text) !== file.size))) throw new Error("Invalid workspace baseline record");
    }
    candidate.files = Object.assign(Object.create(null) as Record<string, FileRecord>, candidate.files);
    return candidate;
  }
  async prepare(signal: AbortSignal): Promise<void> {
    if (this.git === undefined) {
      try {
        const probe = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: this.root, signal, timeoutMs: 10000 });
        this.git = probe.exitCode === 0;
      } catch { signal.throwIfAborted(); this.git = false; }
    }
    if (this.git || this.baseline) return;
    if (this.reference) {
      try { this.baseline = await this.restore(this.reference); return; }
      catch { signal.throwIfAborted(); this.missingHistory = true; }
    }
    this.baseline = await this.capture(signal, true);
    if (this.blobs) this.reference = await this.blobs.put({ bytes: Buffer.from(JSON.stringify(this.baseline)), mimeType: "application/json", source: "file" });
  }
  private async text(record: FileRecord | undefined): Promise<string | undefined> {
    if (!record) return "";
    if (record.text !== undefined) return record.text;
    if (record.textRef && this.blobs) {
      try {
        const data = await this.blobs.read(record.textRef);
        if (data.length === record.size && digest(data) === record.hash) return data.toString("utf8");
      } catch { /* Missing saved content must remain explicit incomplete evidence. */ }
    }
    return undefined;
  }
  private async build(signal: AbortSignal): Promise<DiffSession> {
    const before = this.baseline!;
    const after = await this.capture(signal);
    const entries: DiffEntry[] = [];
    const manifest: Array<Omit<DiffEntry, "complete">> = [];
    let complete = before.complete && after.complete && !before.missingHistory;
    for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
      signal.throwIfAborted();
      const old = before.files[path], current = after.files[path];
      if (old?.hash === current?.hash) continue;
      const metadata = {
        path, status: !old ? "added" as const : !current ? "deleted" as const : "modified" as const,
        ...(old ? { before: { hash: old.hash, size: old.size, binary: old.binary } } : {}),
        ...(current ? { after: { hash: current.hash, size: current.size, binary: current.binary } } : {}),
      };
      manifest.push(metadata);
      if ((!old || old.binary) && (!current || current.binary)) { entries.push({ ...metadata, complete: true }); continue; }
      // A text/binary conversion still exposes the entire textual side; binary metadata must
      // not conceal newly added source or source removed by a conversion to binary.
      const [oldText, currentText] = await Promise.all([old?.binary ? "" : this.text(old), current?.binary ? "" : this.text(current)]);
      if (oldText === undefined || currentText === undefined) {
        complete = false;
        entries.push({ ...metadata, complete: false, reason: "Saved text content is unavailable; metadata alone cannot certify source changes." });
        continue;
      }
      const diff = `--- ${old ? path + (old.binary ? " (binary)" : "") : "/dev/null"}\n+++ ${current ? path + (current.binary ? " (binary)" : "") : "/dev/null"}\n`
        + oldText.split("\n").map(line => "-" + line).join("\n") + "\n" + currentText.split("\n").map(line => "+" + line).join("\n");
      const parts = Math.ceil(diff.length / PART_LIMIT);
      for (let part = 0; part < parts; part++) {
        entries.push({ ...metadata, diff: diff.slice(part * PART_LIMIT, (part + 1) * PART_LIMIT),
          ...(parts > 1 ? { part: part + 1, parts } : {}), complete: part === parts - 1 });
      }
    }
    const snapshot: WorkspaceSnapshot = { files: Object.fromEntries(Object.entries(after.files).map(([path, record]) => [path, record.hash])), complete: after.complete, scanned: 0, skipped: 0, truncated: false };
    return { id: randomUUID(), fingerprint: workspaceFingerprint(snapshot), entries, offset: 0, pagesRead: 0, complete, changedFiles: manifest.length, manifestDigest: digest(JSON.stringify(manifest)) };
  }
  private failure(code: string, reason: string): ToolResult {
    return { output: { source: "workspace_baseline", complete: false, code, reason, nextAction: "Call workspace_diff with {} to start a fresh review; follow every returned nextCursor in order." }, truncated: true, isError: true };
  }
  tool(): ToolDefinition {
    return {
      contract: {
        name: "workspace_diff",
        description: "Inspect changes using Git or a saved pre-edit baseline. Non-Git text is paged with nextCursor; call again with that cursor until complete=true. Only ordered full coverage of an unchanged snapshot is acceptable. Binary files use hash/size metadata. The output declares excluded dependency/cache/build directories. Missing historical or source coverage remains incomplete.",
        inputSchema: { type: "object", properties: { cursor: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false }, risk: "read", idempotent: true, timeoutMs: 30000,
      },
      execute: async (input, context): Promise<ToolResult> => {
        await this.prepare(context.signal);
        if (this.git) return gitDiffTool.execute({}, context);
        if (input.cursor !== undefined) {
          if (typeof input.cursor !== "string" || !this.session?.nextCursor || input.cursor !== this.session.nextCursor) return this.failure("diff_cursor_invalid", "The cursor does not continue the active review. Pages cannot be skipped or reused.");
          const current = await snapshotWorkspace(this.root, context.signal);
          if (!current.complete || workspaceFingerprint(current) !== this.session.fingerprint) {
            this.session = undefined;
            return this.failure("diff_snapshot_changed", "The workspace changed during review or cannot be fully scanned. Previous pages do not certify the current changes.");
          }
        } else this.session = await this.build(context.signal);
        const session = this.session!;
        const files: DiffEntry[] = [];
        let bytes = 0;
        while (session.offset < session.entries.length) {
          const entry = session.entries[session.offset]!;
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (bytes + size > PAGE_LIMIT && files.length) break;
          // Individual chunks are bounded, but an extreme path/metadata entry must fail closed.
          if (size > PAGE_LIMIT) return this.failure("diff_entry_exceeds_budget", "A changed file entry exceeds the output budget and has not been fully inspected.");
          files.push(entry); bytes += size; session.offset++;
        }
        session.pagesRead++;
        const hasMore = session.offset < session.entries.length;
        if (hasMore) session.nextCursor = `${session.id}:${session.offset}:${randomUUID()}`;
        else delete session.nextCursor;
        const complete = session.complete && !hasMore;
        const missingHistory = this.baseline!.missingHistory;
        const output = {
          source: "workspace_baseline", files, complete, truncated: !complete, hasMore,
          ...(session.nextCursor ? { nextCursor: session.nextCursor } : {}),
          summary: { changedFiles: session.changedFiles, totalParts: session.entries.length, coveredParts: session.offset, pagesRead: session.pagesRead, manifestDigest: session.manifestDigest, workspaceFingerprint: session.fingerprint },
          scope: { excludedDirectories: workspaceSnapshotExcludedDirectories, binaryReview: "sha256_and_size_metadata", textReview: "all_changed_text_in_ordered_pages" },
          ...(missingHistory ? { code: "baseline_history_missing", reason: "No valid pre-edit baseline survives for earlier changes. This baseline covers subsequent edits only; earlier differences cannot be certified." }
            : !session.complete ? { code: "diff_coverage_incomplete", reason: "The baseline/current scan or saved changed text is incomplete. Completing pagination cannot certify unavailable source or skipped files." } : {}),
          ...(hasMore ? { nextAction: "Call workspace_diff with {cursor: nextCursor}. Acceptance is blocked until every page has been read against the same unchanged workspace." } : {}),
        };
        if (Buffer.byteLength(JSON.stringify(output)) > 80_000) return this.failure("diff_page_exceeds_budget", "The page envelope exceeds the bounded output budget; restart the review.");
        return { output, truncated: !complete };
      },
    };
  }
}
