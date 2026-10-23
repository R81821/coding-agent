import { createHash } from "node:crypto";
import {
  AttachmentPreviewParamsSchema,
  MAX_ATTACHMENT_BYTES,
  type AttachmentPreview,
  type AttachmentPreviewParams,
  type AttachmentRef,
  type RunSpec,
  type SessionRecord,
} from "@harness/protocol";
import { sniffImage } from "./attachment-ingest.js";

export interface AttachmentPreviewTarget {
  database: {
    getRun(runId: string): { spec: RunSpec } | undefined;
    getVisibleSession(sessionId: string): SessionRecord | undefined;
    getAttachment(attachmentId: string): AttachmentRef | undefined;
  };
  blobs: { read(attachment: AttachmentRef): Promise<Buffer> };
}

/** Read only a persisted raster image belonging to a visible run. Never accepts a path from the renderer. */
export async function readAttachmentPreview(input: AttachmentPreviewParams, target: AttachmentPreviewTarget): Promise<AttachmentPreview> {
  const { runId, attachmentId } = AttachmentPreviewParamsSchema.parse(input);
  const run = target.database.getRun(runId);
  if (!run || !target.database.getVisibleSession(run.spec.sessionId)) throw new Error("会话不存在或已删除");
  const owned = run.spec.attachments.find(attachment => attachment.id === attachmentId);
  if (!owned) throw new Error("附件不属于此消息");
  // Run metadata proves membership; only the trusted attachment table supplies the blob path.
  const attachment = target.database.getAttachment(attachmentId);
  if (!attachment || attachment.id !== attachmentId) throw new Error("附件不存在");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType)) throw new Error("附件不是支持预览的图片");
  if (attachment.sha256 !== owned.sha256 || attachment.mimeType !== owned.mimeType || attachment.byteLength !== owned.byteLength) throw new Error("附件引用不一致");
  if (attachment.byteLength < 1 || attachment.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("图片大小必须在 1 字节到 30 MB 之间");
  const bytes = await target.blobs.read(attachment);
  if (bytes.byteLength !== attachment.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("图片内容校验失败");
  const mimeType = sniffImage(bytes);
  if (mimeType !== attachment.mimeType) throw new Error("图片内容与类型不一致");
  // Recheck after I/O so a deleted/purged/withdrawn run cannot finish an in-flight preview.
  const current = target.database.getRun(runId);
  if (!current || !target.database.getVisibleSession(current.spec.sessionId) || !current.spec.attachments.some(item => item.id === attachmentId && item.sha256 === attachment.sha256)) throw new Error("会话不存在或已删除");
  return { mimeType: attachment.mimeType as AttachmentPreview["mimeType"], base64: bytes.toString("base64") };
}
