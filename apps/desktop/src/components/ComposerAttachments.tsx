import React, { useState } from "react";
import { FileCode, FileText, Image as ImageIcon, X } from "lucide-react";
import type { DesktopAttachment } from "../preload.js";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../ui/attachment.js";
import "./composer-attachments.css";

function attachmentName(item: DesktopAttachment, index: number): string {
  const fileName = item.fileName ?? item.attachment.fileName;
  if (fileName?.trim()) return fileName;
  const sourceNames = { file: "图片附件", clipboard: "剪贴板图片", screenshot: "截图", browser: "浏览器图片", telegram: "图片附件", feishu: "图片附件" };
  return `${item.attachment.mimeType.startsWith("image/") ? sourceNames[item.attachment.source] ?? "图片附件" : "附件"} ${index + 1}`;
}

function byteLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1).replace(/\.0$/, "")} ${units[index]}`;
}

function attachmentMetadata(item: DesktopAttachment): string {
  const { mimeType, byteLength, width, height } = item.attachment;
  const extension = (item.fileName ?? item.attachment.fileName ?? "").split(".").at(-1)?.toLowerCase() ?? "";
  const extensionLabel = ({ ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", md: "Markdown", json: "JSON", csv: "CSV" } as Record<string, string>)[extension];
  const format = !mimeType.startsWith("image/") && extensionLabel ? extensionLabel : ({ "image/png": "PNG", "image/jpeg": "JPG", "image/gif": "GIF", "image/webp": "WebP", "application/pdf": "PDF", "text/plain": "文本文档", "text/markdown": "Markdown", "text/csv": "CSV", "application/json": "JSON", "text/javascript": "JavaScript", "application/javascript": "JavaScript", "text/typescript": "TypeScript", "application/octet-stream": "文件" } as Record<string, string>)[mimeType] ?? (mimeType.startsWith("text/") ? "文本文档" : "文件");
  const dimensions = typeof width === "number" && width > 0 && typeof height === "number" && height > 0 ? `${width} × ${height}` : "";
  return [format, byteLabel(byteLength), dimensions].filter(Boolean).join(" · ");
}

function Thumbnail({ src, name, image }: { src: string; name: string; image: boolean }) {
  const [failed, setFailed] = useState(false);
  if (src && image && !failed) return <img src={src} alt={name} draggable={false} onError={() => setFailed(true)} />;
  const Icon = image ? ImageIcon : /\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|css|scss|html?|vue|svelte|sh|ps1|sql|json|ya?ml)$/i.test(name) ? FileCode : FileText;
  return <Icon aria-hidden="true" />;
}

function revealFocusedAttachment(event: React.FocusEvent<HTMLDivElement>) {
  const card = event.currentTarget;
  // Run after native focus scrolling, which otherwise overrides the card's snap position.
  requestAnimationFrame(() => {
    const group = card.parentElement;
    if (!card.isConnected || !group || !card.contains(document.activeElement)) return;
    const bounds = group.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    if (rect.left < bounds.left || rect.right > bounds.right) card.scrollIntoView({ block: "nearest", inline: "start" });
  });
}

export function ComposerAttachments({ attachments, onRemove, disabled = false }: {
  attachments: DesktopAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  if (!attachments.length) return null;
  return <AttachmentGroup className="composer-attachments" role="group" aria-label="待发送附件">
    {attachments.map((item, index) => {
      const name = attachmentName(item, index);
      const image = item.attachment.mimeType.startsWith("image/");
      return <Attachment key={`${item.attachment.id}:${index}`} size="sm" orientation={image ? "vertical" : "horizontal"}
        className={image ? "composer-attachment-image" : "composer-attachment-file"} data-attachment-id={item.attachment.id} onFocus={revealFocusedAttachment}>
        <AttachmentMedia variant={image && item.previewDataUrl ? "image" : "icon"}>
          <Thumbnail key={item.previewDataUrl} src={item.previewDataUrl} name={name} image={image} />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{name}</AttachmentTitle>
          <AttachmentDescription>{attachmentMetadata(item)}</AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction aria-label={`移除附件 ${name}`} disabled={disabled} onClick={() => onRemove(index)}><X /></AttachmentAction>
        </AttachmentActions>
      </Attachment>;
    })}
  </AttachmentGroup>;
}
