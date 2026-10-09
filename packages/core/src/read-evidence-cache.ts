import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { canonicalJson, type ToolCall } from "@harness/protocol";
import { confinedPath, type ToolResult } from "@harness/tools";

/** Validate content, not just mtime/size: same-size edits must invalidate cached reads. */
export class ReadEvidenceCache {
  private readonly entries = new Map<string, { digest: string; id: string; truncated: boolean; range: Record<string, unknown> }>();
  async identify(call: ToolCall, workspace: string, signal?: AbortSignal): Promise<{ key: string; digest: string } | undefined> {
    if (!["read_file", "read_range"].includes(call.name) || typeof call.input.path !== "string") return;
    try {
      const path = await confinedPath(workspace, call.input.path);
      if ((await stat(path)).size > 64 * 1024 * 1024) return;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
      // Preserve the requested spelling/range as well as the confined target. Review provenance
      // matches the original request; a different path alias should receive a fresh raw result.
      return { key: canonicalJson({ tool: call.name, input: call.input, path }), digest: hash.digest("hex") };
    } catch { return; }
  }
  lookup(identity: { key: string; digest: string } | undefined, availableEvidenceIds?: ReadonlySet<string>): ToolResult | undefined {
    const found = identity && this.entries.get(identity.key);
    if (found && found.digest === identity!.digest && (!availableEvidenceIds || availableEvidenceIds.has(found.id))) return { truncated: found.truncated, output: { reusedEvidenceId: found.id, unchanged: true, truncated: found.truncated, ...found.range, guidance: "Reconfirmed unchanged content for this requested range. Reuse this content directly; read_evidence retrieves any output omitted by the context budget. Do not repeat the file read to correct patch formatting." } };
    return;
  }
  remember(identity: { key: string; digest: string } | undefined, callId: string, result: ToolResult): void {
    if (!identity || result.isError) return;
    if (result.output && typeof result.output === "object" && "reusedEvidenceId" in result.output) return;
    if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    const output = typeof result.output === "string" ? { content: result.output }
      : result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : {};
    const range = Object.fromEntries(["path", "offset", "returnedLines", "hasMore", "nextOffset", "content"].filter(key => key in output).map(key => [key, output[key]]));
    this.entries.set(identity.key, { digest: identity.digest, id: callId, truncated: result.truncated === true, range });
  }
}
