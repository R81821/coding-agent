import { attachmentFileName, MAX_ATTACHMENT_BYTES, type AttachmentRef } from "@harness/protocol";

export interface UploadedAttachment {
  base64: string;
  mimeType: string;
  fileName?: string | undefined;
  source: AttachmentRef["source"];
  allowedProviders: string[];
}

export interface AttachmentIngestTarget {
  blobs: { put(input: { bytes: Buffer; mimeType: string; fileName?: string; textTokenEstimate?: number; source: AttachmentRef["source"]; allowedProviders: string[] }): Promise<AttachmentRef> };
  database: { saveAttachment(attachment: AttachmentRef): void };
}

/** Decode once, validate before persisting, and keep the original file bytes encrypted. */
export async function ingestUploadedAttachment(
  input: UploadedAttachment,
  target: AttachmentIngestTarget,
  validateFile: (input: { bytes: Buffer; mimeType: string; fileName?: string }) => Promise<{ textTokenEstimate: number }>,
): Promise<AttachmentRef> {
  if (!input.base64 || input.base64.length % 4 !== 0 || input.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) {
    throw new Error("附件内容无效或超过 30 MB，请重新选择文件。");
  }
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64) throw new Error("附件内容编码无效，请重新选择文件。");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("附件大小必须在 1 字节到 30 MB 之间。");
  const imageMime = sniffImage(bytes);
  let textTokenEstimate: number | undefined;
  if (input.mimeType.startsWith("image/") || imageMime) {
    if (!imageMime || imageMime !== input.mimeType) throw new Error(`Image content does not match declared MIME type (${input.mimeType})`);
  } else {
    const fileName = input.fileName ? attachmentFileName(input.fileName) : undefined;
    ({ textTokenEstimate } = await validateFile({ bytes, mimeType: input.mimeType, ...(fileName ? { fileName } : {}) }));
  }
  const fileName = input.fileName ? attachmentFileName(input.fileName) : undefined;
  const attachment = await target.blobs.put({
    bytes, mimeType: imageMime ?? input.mimeType, source: input.source, allowedProviders: input.allowedProviders,
    ...(fileName ? { fileName } : {}),
    ...(textTokenEstimate !== undefined ? { textTokenEstimate } : {}),
  });
  target.database.saveAttachment(attachment);
  return attachment;
}

export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
