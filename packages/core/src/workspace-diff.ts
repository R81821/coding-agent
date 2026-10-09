import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AttachmentRef } from "@harness/protocol";
import type { EncryptedBlobStore } from "@harness/persistence";
import { confinedPath, gitDiffTool, runProcess, type ToolDefinition, type ToolResult } from "@harness/tools";
import { snapshotWorkspace } from "./workspace-impact.js";

interface FileRecord { hash: string; size: number; binary: boolean; text?: string }
interface Baseline { files: Record<string, FileRecord>; complete: boolean; missingHistory: boolean }
const TEXT_LIMIT = 64_000;
const TOTAL_LIMIT = 384_000;

/** Baselines live in the encrypted application blob store, never in the user's directory. */
export class WorkspaceDiff {
  private baseline?: Baseline;
  private git?: boolean;
  reference: AttachmentRef | undefined;
  constructor(private root: string, private blobs?: EncryptedBlobStore, reference?: AttachmentRef, private missingHistory = false) {
    this.reference = reference;
  }
  private async capture(signal: AbortSignal): Promise<Baseline> {
    const snapshot = await snapshotWorkspace(this.root, signal);
    const result: Baseline = { files: {}, complete: snapshot.complete, missingHistory: this.missingHistory };
    let bytes = 0;
    for (const [path, hash] of Object.entries(snapshot.files)) {
      try {
        const data = await readFile(await confinedPath(this.root, path));
        if (createHash("sha256").update(data).digest("hex") !== hash) { result.complete = false; continue; }
        const text = data.toString("utf8");
        const binary = data.includes(0) || !Buffer.from(text).equals(data);
        const record: FileRecord = { hash, size: data.length, binary };
        if (!binary && data.length <= TEXT_LIMIT && bytes + data.length <= TOTAL_LIMIT) { record.text = text; bytes += data.length; }
        result.files[path] = record;
      } catch { signal.throwIfAborted(); result.complete = false; }
    }
    return result;
  }
  async prepare(signal: AbortSignal): Promise<void> {
    if (this.git === undefined) {
      const probe = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: this.root, signal, timeoutMs: 10000 });
      this.git = probe.exitCode === 0;
    }
    if (this.git || this.baseline) return;
    if (this.reference && this.blobs) {
      try { this.baseline = JSON.parse((await this.blobs.read(this.reference)).toString("utf8")) as Baseline; return; }
      catch { this.missingHistory = true; }
    }
    this.baseline = await this.capture(signal);
    if (this.blobs) this.reference = await this.blobs.put({ bytes: Buffer.from(JSON.stringify(this.baseline)), mimeType: "application/json", source: "file" });
  }
  tool(): ToolDefinition {
    return {
      contract: { name: "workspace_diff", description: "Inspect current changes. Uses Git when available, otherwise the saved pre-edit workspace baseline. Text diffs and binary metadata are bounded; incomplete or missing historical coverage is explicit. Read after verification for final review.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", idempotent: true, timeoutMs: 30000 },
      execute: async (_input, context): Promise<ToolResult> => {
        await this.prepare(context.signal);
        if (this.git) return gitDiffTool.execute({}, context);
        const before = this.baseline!;
        const after = await this.capture(context.signal);
        let truncated = !before.complete || !after.complete || before.missingHistory;
        let bytes = 0;
        const files = [];
        for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
          const old = before.files[path], current = after.files[path];
          if (old?.hash === current?.hash) continue;
          const metadata = { path, status: !old ? "added" : !current ? "deleted" : "modified", before: old && { hash: old.hash, size: old.size, binary: old.binary }, after: current && { hash: current.hash, size: current.size, binary: current.binary } };
          const binary = old?.binary || current?.binary;
          const complete = binary || ((!old || old.text !== undefined) && (!current || current.text !== undefined));
          const diff = binary ? undefined : complete ? `--- ${old ? path : "/dev/null"}\n+++ ${current ? path : "/dev/null"}\n` + (old?.text ?? "").split("\n").map(line => "-" + line).join("\n") + "\n" + (current?.text ?? "").split("\n").map(line => "+" + line).join("\n") : undefined;
          const entry = { ...metadata, ...(diff !== undefined ? { diff } : {}), complete, ...(complete ? {} : { reason: "Text exceeds baseline or output budget" }) };
          bytes += Buffer.byteLength(JSON.stringify(entry));
          if (bytes > TOTAL_LIMIT) { truncated = true; break; }
          if (!complete) truncated = true;
          files.push(entry);
        }
        return { output: { source: "workspace_baseline", files, complete: !truncated, truncated, ...(before.missingHistory ? { code: "baseline_history_missing", reason: "No pre-edit baseline survives for earlier changes. This baseline covers subsequent edits only; earlier differences cannot be certified." } : {}) }, truncated };
      },
    };
  }
}
