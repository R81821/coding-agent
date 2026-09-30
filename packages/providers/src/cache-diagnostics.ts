import { createHash } from "node:crypto";
import { canonicalJson, type CacheDiagnostic, type ModelRequest } from "@harness/protocol";

/** Tracks attempted adapted requests. Keeps only hashes and lengths, never prompt bodies. */
export class WireCacheDiagnostics {
  private readonly previous = new Map<string, { scope: string; items: { hash: string; length: number }[] }>();
  observe(request: ModelRequest, protocol: CacheDiagnostic["protocol"], body: Record<string, unknown>, fullInput?: unknown[], continuationFallback = false): CacheDiagnostic {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const input = (body.input ?? body.messages ?? body.contents ?? []) as unknown[];
    const scope = hash(canonicalJson({ model: request.model.modelId, instructions: body.instructions ?? body.system ?? body.systemInstruction, tools: body.tools, key: body.prompt_cache_key }));
    const items = (fullInput ?? input).map(item => { const serialized = canonicalJson(item); return { hash: hash(serialized), length: serialized.length }; });
    const key = canonicalJson([request.runId, request.purpose ?? "main", protocol]);
    const prior = this.previous.get(key);
    let unchanged = 0;
    if (prior?.scope === scope) while (unchanged < items.length && prior.items[unchanged]?.hash === items[unchanged]?.hash) unchanged++;
    const continuation = typeof body.previous_response_id === "string";
    const reason = continuationFallback ? "continuation_fallback" : continuation ? "continuation" : !prior ? "first_request" : prior.scope === scope && unchanged === prior.items.length ? "append" : "rewrite";
    // A continuation carries only the tail; do not report that as a broken full prefix.
    this.previous.delete(key);
    this.previous.set(key, { scope, items });
    if (this.previous.size > 64) this.previous.delete(this.previous.keys().next().value!);
    return { purpose: request.purpose ?? "main", protocol, reason, unchangedPrefixItems: continuation || continuationFallback ? 0 : unchanged, inputItems: input.length,
      sharedPrefixCharacters: continuation || continuationFallback ? 0 : items.slice(0, unchanged).reduce((sum, item) => sum + item.length, 0), payloadCharacters: canonicalJson(body).length };
  }
}
