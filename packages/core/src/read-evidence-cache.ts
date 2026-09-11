import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { canonicalJson, type ToolCall } from "@harness/protocol";
import { confinedPath, type ToolResult } from "@harness/tools";

/** Validate content, not just mtime/size: same-size edits must invalidate cached reads. */
export class ReadEvidenceCache {
  private readonly entries = new Map<string, { digest: string; id: string }>();
  async identify(call: ToolCall, workspace: string, signal?: AbortSignal): Promise<{ key: string; digest: string } | undefined> {
    if (!["read_file", "read_range"].includes(call.name) || typeof call.input.path !== "string") return;
    try {
      const path = await confinedPath(workspace, call.input.path);
      if ((await stat(path)).size > 64 * 1024 * 1024) return;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
      return { key: canonicalJson({ tool: call.name, ...call.input, path }), digest: hash.digest("hex") };
    } catch { return; }
  }
  lookup(identity: { key: string; digest: string } | undefined): ToolResult | undefined {
    const found = identity && this.entries.get(identity.key);
    if (found && found.digest === identity!.digest) return { output: { reusedEvidenceId: found.id, unchanged: true, guidance: "Use the saved evidence; read_evidence retrieves its full contents." } };
    return;
  }
  remember(identity: { key: string; digest: string } | undefined, callId: string, result: ToolResult): void {
    if (!identity || result.isError) return;
    if (result.output && typeof result.output === "object" && "reusedEvidenceId" in result.output) return;
    if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(identity.key, { digest: identity.digest, id: callId });
  }
}
