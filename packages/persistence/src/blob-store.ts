import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AttachmentRef } from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";
import type { VaultCrypto } from "./crypto.js";

export interface PutAttachmentInput {
  bytes: Buffer;
  mimeType: string;
  fileName?: string;
  textTokenEstimate?: number;
  source: AttachmentRef["source"];
  allowedProviders?: string[];
  width?: number;
  height?: number;
}

export class EncryptedBlobStore {
  constructor(private readonly root: string, private readonly crypto: VaultCrypto) {}

  async put(input: PutAttachmentInput): Promise<AttachmentRef> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const path = join(this.root, sha256.slice(0, 2), `${sha256}.hab`);
    await mkdir(dirname(path), { recursive: true });
    const encrypted = this.crypto.encryptBuffer(input.bytes, `attachment:${sha256}`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      id: newId("attachment"),
      sha256,
      mimeType: input.mimeType,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.textTokenEstimate !== undefined ? { textTokenEstimate: input.textTokenEstimate } : {}),
      byteLength: input.bytes.byteLength,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      encryptedPath: path,
      source: input.source,
      trust: "untrusted_attachment",
      allowedProviders: input.allowedProviders ?? [],
      createdAt: nowIso()
    };
  }

  async read(attachment: AttachmentRef): Promise<Buffer> {
    const target = resolve(attachment.encryptedPath);
    const rel = relative(resolve(this.root), target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error(`Attachment path escapes the blob store: ${attachment.encryptedPath}`);
    const encrypted = await readFile(target);
    return this.crypto.decryptBuffer(encrypted, `attachment:${attachment.sha256}`);
  }
}

