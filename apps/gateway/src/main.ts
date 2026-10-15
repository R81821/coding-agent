import { randomInt } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import type { AttachmentRef, ModelMessage, ModelRequest, ToolContract } from "@harness/protocol";
import { nowIso } from "@harness/protocol";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider, descriptor, type ModelProvider, type ResolvedAttachment } from "@harness/providers";
import { GatewayStore, type StoredProvider } from "./store.js";
import { createPairRateLimiter } from "./rate-limit.js";

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const databaseUrl = required("DATABASE_URL");
const masterKey = required("GATEWAY_MASTER_KEY");
const adminKey = process.env.GATEWAY_ADMIN_KEY ?? masterKey;
// Key rotation: GATEWAY_MASTER_KEY_V2 becomes the current encryption key (stamped
// "v2"); the original master key and any GATEWAY_MASTER_KEY_ARCHIVE entries stay
// decrypt-only so existing ciphertext remains readable.
const archiveKeys: Array<{ version: string; key: string }> = [];
if (process.env.GATEWAY_MASTER_KEY_V2) archiveKeys.push({ version: "v1", key: masterKey });
(process.env.GATEWAY_MASTER_KEY_ARCHIVE ?? "").split(",").map((key) => key.trim()).filter(Boolean).forEach((key, index) => archiveKeys.push({ version: `archive-${index + 1}`, key }));
const currentKey = process.env.GATEWAY_MASTER_KEY_V2 ?? masterKey;
const currentVersion = process.env.GATEWAY_MASTER_KEY_V2 ? "v2" : "v1";
const store = new GatewayStore(databaseUrl, masterKey, archiveKeys, currentKey, currentVersion);
await store.migrate();
const rateLimitPair = createPairRateLimiter();

const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-admin-key", "body.apiKey"] }, bodyLimit: 30_000_000 });

app.get("/health", async () => ({ status: "ok", version: "1.4.51" }));

app.post("/admin/pairing-codes", { preHandler: requireAdmin }, async () => {
  const code = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
  await store.createPairingCode(code, new Date(Date.now() + 10 * 60_000));
  return { code, expiresInSeconds: 600 };
});

const providerInput = z.object({
  id: z.string(),
  type: z.enum(["openai", "anthropic", "gemini", "openai-compatible"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  models: z.array(z.object({
    alias: z.string(), modelId: z.string(), vision: z.boolean().default(true), qualityScore: z.number().min(0).max(1).default(0.8), latencyScore: z.number().min(0).max(1).default(0.7), inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive()
  })).min(1)
});
app.post("/admin/providers", { preHandler: requireAdmin }, async (request) => {
  const provider = providerInput.parse(request.body);
  await store.putProvider(provider);
  return { id: provider.id, models: provider.models.map((model) => model.alias) };
});

app.delete("/admin/devices/:id", { preHandler: requireAdmin }, async (request) => {
  const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
  await store.revokeDevice(id);
  return { revoked: true };
});

app.get("/admin/audit", { preHandler: requireAdmin }, async () => store.listAudit());

app.post("/v1/pair", async (request, reply) => {
  if (!rateLimitPair(request.ip)) return reply.code(429).send({ error: { message: "Too many pairing attempts" } });
  const input = z.object({ code: z.string().length(8), deviceName: z.string().min(1).max(100) }).parse(request.body);
  return store.pair(input.code, input.deviceName);
});

app.get("/v1/models", { preHandler: requireDevice }, async () => {
  const providers = await store.listProviders();
  return { object: "list", data: providers.flatMap((provider) => provider.models.map((model) => ({ id: model.alias, object: "model", owned_by: provider.id }))) };
});

app.post("/v1/chat/completions", { preHandler: requireDevice }, async (request, reply) => {
  const body = chatInput.parse(request.body);
  const device = (request as any).device as { id: string; maxDailyUsd: number };
  if (await store.usedToday(device.id) >= device.maxDailyUsd) return reply.code(429).send({ error: { message: "Daily model budget exhausted" } });
  const selected = await store.findModel(body.model);
  if (!selected) return reply.code(404).send({ error: { message: `Unknown model alias: ${body.model}` } });

  const attachments = new Map<string, ResolvedAttachment>();
  const messages = parseMessages(body.messages, attachments);
  const provider = buildProvider(selected.provider, selected.model, async (attachment) => {
    const resolved = attachments.get(attachment.id);
    if (!resolved) throw new Error(`Unknown inline attachment: ${attachment.id}`);
    return resolved;
  });
  const model = (await provider.listModels())[0];
  if (!model) throw new Error("Provider has no configured model");
  const tools: ToolContract[] = body.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
    risk: "high",
    idempotent: false,
    timeoutMs: 60_000
  }));
  const modelRequest: ModelRequest = {
    runId: crypto.randomUUID(),
    model,
    messages,
    tools,
    maxOutputTokens: body.max_tokens ?? 4_096,
    parallelToolCalls: body.parallel_tool_calls,
    store: false
  };
  const controller = new AbortController();
  request.raw.on("close", () => controller.abort());
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  const completionId = `chatcmpl_${crypto.randomUUID()}`;
  try {
    for await (const event of provider.stream(modelRequest, controller.signal)) {
      if (event.type === "text_delta") writeSse(reply.raw, { id: completionId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] });
      if (event.type === "tool_call" && event.toolCall) writeSse(reply.raw, { id: completionId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.toolCall.id, type: "function", function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.input) } }] }, finish_reason: "tool_calls" }] });
      if (event.type === "usage" && event.usage) {
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        estimatedUsd += event.usage.estimatedUsd;
      }
    }
    writeSse(reply.raw, { id: completionId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  } catch (error) {
    writeSse(reply.raw, { error: { message: error instanceof Error ? error.message : String(error) } });
    reply.raw.end();
  } finally {
    // Audit even when the client disconnects mid-stream or the provider fails,
    // so consumed tokens always count against the device's daily budget.
    if (inputTokens === 0 && outputTokens === 0) inputTokens = Math.max(1, Math.ceil(JSON.stringify(body.messages).length / 4));
    if (estimatedUsd === 0 && (inputTokens > 0 || outputTokens > 0)) {
      estimatedUsd = (selected.model.inputUsdPerMillion * inputTokens + selected.model.outputUsdPerMillion * outputTokens) / 1_000_000;
    }
    await store.audit(device.id, selected.provider.id, selected.model.modelId, inputTokens, outputTokens, estimatedUsd).catch(() => {
      /* auditing must not break an in-flight response */
    });
  }
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8787) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void Promise.all([app.close(), store.close()]).finally(() => process.exit(0)));
}

async function requireAdmin(request: any, reply: any): Promise<void> {
  if (request.headers["x-admin-key"] !== adminKey) await reply.code(401).send({ error: "unauthorized" });
}

async function requireDevice(request: any, reply: any): Promise<void> {
  const header = String(request.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const device = token ? await store.authenticate(token) : undefined;
  if (!device) await reply.code(401).send({ error: { message: "invalid device token" } });
  else request.device = device;
}

const chatInput = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant", "tool"]), content: z.union([z.string(), z.array(z.record(z.string(), z.any()))]), tool_call_id: z.string().optional() })),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.any()).optional() }) })).default([]),
  stream: z.boolean().default(true),
  max_tokens: z.number().int().positive().optional(),
  parallel_tool_calls: z.boolean().default(true)
});

function parseMessages(input: z.infer<typeof chatInput>["messages"], attachments: Map<string, ResolvedAttachment>): ModelMessage[] {
  return input.map((message) => {
    const content: ModelMessage["content"] = [];
    if (typeof message.content === "string") content.push({ type: "text", text: message.content, trust: message.role === "user" ? "user_request" : "untrusted_tool" });
    else for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: String(part.text ?? ""), trust: message.role === "user" ? "user_request" : "untrusted_tool" });
      if (part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : String((part.image_url as any)?.url ?? "");
        const match = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match?.[1] || !match[2]) throw new Error("Gateway only accepts inline PNG/JPEG/GIF/WebP data URLs");
        const id = `inline_${crypto.randomUUID()}`;
        attachments.set(id, { mimeType: match[1], base64: match[2] });
        content.push({ type: "image", detail: "auto", attachment: { id, sha256: "0".repeat(64), mimeType: match[1], byteLength: Buffer.byteLength(match[2], "base64"), encryptedPath: "gateway:inline", source: "file", trust: "untrusted_attachment", allowedProviders: [], createdAt: nowIso() } });
      }
    }
    return { role: message.role, content };
  });
}

function buildProvider(provider: StoredProvider, model: StoredProvider["models"][number], attachmentResolver: (attachment: AttachmentRef) => Promise<ResolvedAttachment>): ModelProvider {
  const models = [descriptor({
    providerId: provider.id,
    modelId: model.modelId,
    displayName: model.alias,
    qualityScore: model.qualityScore,
    latencyScore: model.latencyScore,
    inputUsdPerMillion: model.inputUsdPerMillion,
    outputUsdPerMillion: model.outputUsdPerMillion,
    capabilities: { vision: model.vision, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128_000, dataPolicy: "gateway" }
  })];
  const config = { id: provider.id, apiKey: provider.apiKey, baseUrl: provider.baseUrl, models, resolveAttachment: attachmentResolver };
  switch (provider.type) {
    case "openai": return new OpenAIProvider(config);
    case "anthropic": return new AnthropicProvider(config);
    case "gemini": return new GeminiProvider(config);
    case "openai-compatible": return new OpenAICompatibleProvider(config);
  }
}

function writeSse(stream: NodeJS.WritableStream, value: unknown): void {
  const target = stream as NodeJS.WritableStream & { destroyed?: boolean };
  if (target.destroyed) return;
  target.write(`data: ${JSON.stringify(value)}\n\n`);
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
