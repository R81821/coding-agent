import type { RunSpec } from "@harness/protocol";
import type { DesktopAttachment } from "./preload.js";

export interface ComposerDraft {
  prompt: string;
  attachments: DesktopAttachment[];
  taskMode: "auto" | "analysis" | "change";
}

/** Recover the submitted round without discarding a correction already typed in the composer. */
export function restoreWithdrawnDraft(run: RunSpec, current?: ComposerDraft, submitted?: ComposerDraft): ComposerDraft {
  const correction = current?.prompt ?? "";
  const prompt = correction.trim() && correction.trim() !== run.request.trim()
    ? `${run.request}\n\n${correction}` : run.request;
  const previews = new Map((submitted?.attachments ?? []).map(item => [item.attachment.id, item.previewDataUrl]));
  for (const item of current?.attachments ?? []) if (item.previewDataUrl || !previews.has(item.attachment.id)) previews.set(item.attachment.id, item.previewDataUrl);
  const attachments = new Map<string, DesktopAttachment>();
  for (const attachment of run.attachments) attachments.set(attachment.id, { attachment, previewDataUrl: previews.get(attachment.id) ?? "" });
  for (const item of current?.attachments ?? []) if (!attachments.has(item.attachment.id)) attachments.set(item.attachment.id, item);
  return { prompt, attachments: [...attachments.values()], taskMode: run.taskMode ?? "auto" };
}
