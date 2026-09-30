import { expect, it } from "vitest";
import { OpenAICompatibleProvider, descriptor, type ProviderStreamEvent } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
const model = descriptor({ providerId: "fixture", modelId: "deepseek-flash", displayName: "fixture" });
const request = (): ModelRequest => ({ runId: "run", model, messages: [{ role: "user", content: [{ type: "text", text: "private source", trust: "user_request" }] }], tools: [], maxOutputTokens: 2048, parallelToolCalls: false, store: false, cacheDiagnostics: true });
async function collect(provider: OpenAICompatibleProvider, req: ModelRequest) { const events: ProviderStreamEvent[] = []; for await (const event of provider.stream(req, new AbortController().signal)) events.push(event); return events; }
function fixture(baseUrl: string, apiProtocol: "responses" | "chat_completions") {
  const bodies: Record<string, any>[] = [];
  const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "secret-key", baseUrl, apiProtocol, models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('data: {"type":"response.completed","response":{"id":"resp"}}\n\n'); } });
  return { provider, bodies };
}
it.each(["responses", "chat_completions"] as const)("disables summary thinking only for verified DeepSeek %s", async protocol => {
  const { provider, bodies } = fixture("https://api.deepseek.com", protocol);
  expect(provider.supportsNonThinkingCompaction?.()).toBe(true);
  await collect(provider, { ...request(), purpose: "compaction", disableThinking: true });
  expect(protocol === "responses" ? bodies[0]?.reasoning : bodies[0]?.thinking).toEqual(protocol === "responses" ? { effort: "none" } : { type: "disabled" });
  await collect(provider, request());
  expect(bodies[1]?.reasoning).toBeUndefined(); expect(bodies[1]?.thinking).toBeUndefined();
  const unknown = fixture("https://custom.test", protocol);
  expect(unknown.provider.supportsNonThinkingCompaction?.()).not.toBe(true);
  await collect(unknown.provider, { ...request(), disableThinking: true });
  expect(unknown.bodies[0]?.reasoning).toBeUndefined(); expect(unknown.bodies[0]?.thinking).toBeUndefined();
});
it("measures adapted append and rewrite without recording private content", async () => {
  const { provider } = fixture("https://custom.test", "chat_completions");
  const first = await collect(provider, request());
  const appended = { ...request(), messages: [...request().messages, ...request().messages] };
  const next = await collect(provider, appended);
  const rewrite = await collect(provider, { ...request(), messages: [{ role: "user", content: [{ type: "text", text: "private replacement", trust: "user_request" }] }] });
  expect(first[0]?.diagnostic?.reason).toBe("first_request");
  expect(next[0]?.diagnostic).toMatchObject({ reason: "append", unchangedPrefixItems: 1, inputItems: 2 });
  expect(next[0]?.diagnostic?.sharedPrefixCharacters).toBeGreaterThan(0);
  expect(rewrite[0]?.diagnostic).toMatchObject({ reason: "rewrite", unchangedPrefixItems: 0 });
  expect(JSON.stringify([...first, ...next, ...rewrite])).not.toMatch(/secret-key|private source|private replacement/);
});
it("labels rejected Responses continuation as a full-input fallback without invented shared prefix", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "secret-key", baseUrl: "https://custom.test", apiProtocol: "responses", models: [model], resolveAttachment: async () => { throw Error("unused"); }, fetchImpl: async () => {
    if (++calls === 2) return new Response("previous_response_id expired", { status: 400 });
    return new Response('data: {"type":"response.completed","response":{"id":"resp"}}\n\n');
  } });
  await collect(provider, { ...request(), store: true });
  const events = await collect(provider, { ...request(), store: true, messages: [...request().messages, ...request().messages] });
  expect(events.map(event => event.diagnostic?.reason)).toEqual(["continuation", "continuation_fallback"]);
  expect(events[1]?.diagnostic?.sharedPrefixCharacters).toBe(0);
  expect(calls).toBe(3);
});
