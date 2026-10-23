import React, { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, LoaderCircle, X } from "lucide-react";
import { AttachmentPreviewSchema, type AttachmentRef } from "@harness/protocol";
import "./sent-attachments.css";

/** Only persisted raster bytes may become an image source, never an arbitrary URL or path. */
export function attachmentPreviewDataUrl(value: unknown): string {
  const preview = AttachmentPreviewSchema.parse(value);
  if (!preview.base64.length || preview.base64.length > 40_000_000 || preview.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.base64)) throw new Error("图片预览数据无效");
  return `data:${preview.mimeType};base64,${preview.base64}`;
}

function SentImage({ runId, attachment, name }: { runId: string; attachment: AttachmentRef; name: string }) {
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let cancelled = false;
    setError(false); setPreview(undefined);
    void window.harness.request({ method: "attachment.preview", params: { runId, attachmentId: attachment.id } })
      .then(result => { if (!cancelled) setPreview(attachmentPreviewDataUrl(result)); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [runId, attachment.id, attachment.sha256, attempt]);
  return <figure className="sent-attachment sent-attachment-picture" data-attachment-id={attachment.id} title={name}>
    {error ? <div className="sent-attachment-fallback" role="status"><ImageIcon aria-hidden="true" /><span>图片暂时无法显示</span><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : preview ? <button type="button" className="sent-attachment-open" aria-label={`查看图片 ${name}`} onClick={() => dialog.current?.showModal()}>
        <img className="sent-attachment-image" src={preview} alt={name} draggable={false} onError={() => setError(true)} />
      </button> : <div className="sent-attachment-fallback" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" /><span>加载图片…</span></div>}
    <dialog className="sent-attachment-dialog" ref={dialog} aria-label={`图片预览 ${name}`} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <header><strong>{name}</strong><button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
      {preview && <img src={preview} alt={name} />}
    </dialog>
  </figure>;
}

export function SentAttachments({ runId, attachments }: { runId: string; attachments?: AttachmentRef[] | undefined }) {
  if (!attachments?.length) return null;
  return <div className="sent-attachments" role="group" aria-label="已发送附件">
    {attachments.map((attachment, index) => {
      const image = attachment.mimeType.startsWith("image/");
      const name = attachment.fileName || `${image ? attachment.source === "clipboard" ? "剪贴板图片" : "图片" : "附件"} ${index + 1}`;
      return image ? <SentImage key={`${runId}:${attachment.id}:${attachment.sha256}`} runId={runId} attachment={attachment} name={name} />
        : <div key={attachment.id} className="sent-attachment sent-attachment-file" data-attachment-id={attachment.id} title={name}><FileText aria-hidden="true" /><span>{name}</span></div>;
    })}
  </div>;
}
