import { EventEmitter } from "node:events";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export interface RemoteMessage {
  connector: "telegram" | "feishu";
  messageId: string;
  actorId: string;
  chatId: string;
  text: string;
  attachments: Array<{ fileId: string; mimeType?: string }>;
  receivedAt: string;
}

export abstract class MessageConnector extends EventEmitter {
  abstract readonly id: RemoteMessage["connector"];
  abstract start(signal: AbortSignal): Promise<void>;
  abstract send(chatId: string, text: string): Promise<void>;
  abstract download(fileId: string): Promise<Buffer>;
}

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PAIR_ATTEMPTS = 5;
const MAX_REMOTE_ATTACHMENT_BYTES = 30_000_000;

interface PendingPairing { hash: Buffer; expires: number; attempts: number }

export class PairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly paired = new Set<string>();

  create(connector: string, ttlMs = 10 * 60_000): string {
    const code = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
    this.pending.set(connector, { hash: digest(code), expires: Date.now() + ttlMs, attempts: 0 });
    return code;
  }

  pair(connector: string, actorId: string, code: string): boolean {
    const pending = this.pending.get(connector);
    if (!pending || pending.expires < Date.now()) return false;
    const provided = digest(code);
    const valid = provided.length === pending.hash.length && timingSafeEqual(provided, pending.hash);
    if (!valid) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_PAIR_ATTEMPTS) this.pending.delete(connector);
      return false;
    }
    this.pending.delete(connector);
    this.paired.add(`${connector}:${actorId}`);
    return true;
  }

  isPaired(connector: string, actorId: string): boolean {
    return this.paired.has(`${connector}:${actorId}`);
  }
}

export class TelegramConnector extends MessageConnector {
  readonly id = "telegram" as const;
  private offset = 0;

  constructor(private readonly token: string) { super(); }

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?timeout=30&offset=${this.offset}`, { signal });
      const payload = await response.json() as { ok: boolean; result: any[] };
      if (!payload.ok) throw new Error("Telegram getUpdates failed");
      for (const update of payload.result) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        const message = update.message ?? update.callback_query?.message;
        const actor = update.message?.from ?? update.callback_query?.from;
        if (!message || !actor) continue;
        const remote: RemoteMessage = {
          connector: "telegram",
          messageId: String(message.message_id),
          actorId: String(actor.id),
          chatId: String(message.chat.id),
          text: String(message.text ?? message.caption ?? ""),
          attachments: message.photo?.length ? [{ fileId: String(message.photo.at(-1).file_id), mimeType: "image/jpeg" }] : [],
          receivedAt: new Date(Number(message.date) * 1000).toISOString()
        };
        this.emit("message", remote);
      }
    }
  }

  async send(chatId: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4_096) })
    });
    if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
  }

  async download(fileId: string): Promise<Buffer> {
    const metadata = await fetch(`https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const payload = await metadata.json() as { ok: boolean; result?: { file_path?: string } };
    if (!payload.ok || !payload.result?.file_path) throw new Error("Telegram getFile failed");
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${payload.result.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_REMOTE_ATTACHMENT_BYTES) throw new Error("Telegram file exceeds 30 MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_ATTACHMENT_BYTES) throw new Error("Telegram file exceeds 30 MB");
    return bytes;
  }
}

export class FeishuConnector extends MessageConnector {
  readonly id = "feishu" as const;
  private client: any;

  constructor(private readonly appId: string, private readonly appSecret: string) { super(); }

  async start(signal: AbortSignal): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");
    this.client = new lark.Client({ appId: this.appId, appSecret: this.appSecret });
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        const message = data.message;
        const sender = data.sender;
        const text = safeFeishuText(message?.content);
        this.emit("message", {
          connector: "feishu",
          messageId: String(message?.message_id ?? crypto.randomUUID()),
          actorId: String(sender?.sender_id?.open_id ?? ""),
          chatId: String(message?.chat_id ?? ""),
          text,
          attachments: message?.message_type === "image" ? [{ fileId: JSON.parse(message.content).image_key, mimeType: "image/*" }] : [],
          receivedAt: new Date(Number(message?.create_time ?? Date.now())).toISOString()
        } satisfies RemoteMessage);
      }
    });
    const wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret });
    signal.addEventListener("abort", () => void wsClient.close(), { once: true });
    await wsClient.start({ eventDispatcher: dispatcher });
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      const lark = await import("@larksuiteoapi/node-sdk");
      this.client = new lark.Client({ appId: this.appId, appSecret: this.appSecret });
    }
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }
    });
  }

  async download(fileId: string): Promise<Buffer> {
    if (!this.client) {
      const lark = await import("@larksuiteoapi/node-sdk");
      this.client = new lark.Client({ appId: this.appId, appSecret: this.appSecret });
    }
    const response = await this.client.im.image.get({ path: { image_key: fileId } });
    const bytes = Buffer.isBuffer(response) ? response : Buffer.isBuffer(response?.data) ? response.data : typeof response?.getReadableStream === "function" ? await readableToBuffer(response.getReadableStream(), MAX_REMOTE_ATTACHMENT_BYTES) : undefined;
    if (!bytes) throw new Error("Feishu image download returned an unsupported payload");
    if (bytes.byteLength > MAX_REMOTE_ATTACHMENT_BYTES) throw new Error("Feishu image exceeds 30 MB");
    return bytes;
  }
}

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function safeFeishuText(content: unknown): string {
  try { return String(JSON.parse(String(content ?? "{}")).text ?? ""); } catch { return ""; }
}

async function readableToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("Feishu image exceeds 30 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
