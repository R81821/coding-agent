import { expect, it } from "vitest";
import type { AttachmentRef, RunSpec } from "@harness/protocol";
import { restoreWithdrawnDraft, type ComposerDraft } from "./withdrawal-draft.js";

const attachment = (id: string) => ({ id, mimeType: "image/png" }) as AttachmentRef;
const run = { request: "修复误发的任务", attachments: [attachment("original")], taskMode: "change" } as RunSpec;
const draft = (prompt: string, ids: string[] = []): ComposerDraft => ({ prompt, attachments: ids.map(id => ({ attachment: attachment(id), previewDataUrl: `data:${id}` })), taskMode: "analysis" });

it("restores the original request, task mode and screenshot preview after withdrawal", () => {
  expect(restoreWithdrawnDraft(run, draft(""), draft(run.request, ["original"]))).toEqual({
    prompt: run.request, taskMode: "change", attachments: [{ attachment: attachment("original"), previewDataUrl: "data:original" }]
  });
});

it("preserves a typed correction and added images while deduplicating original attachments", () => {
  const restored = restoreWithdrawnDraft(run, draft("改为只分析", ["original", "new"]), draft(run.request, ["original"]));
  expect(restored.prompt).toBe(`${run.request}\n\n改为只分析`);
  expect(restored.attachments.map(item => item.attachment.id)).toEqual(["original", "new"]);
  expect(restored.attachments[0]?.previewDataUrl).toBe("data:original");
  expect(restored.taskMode).toBe("change");
});

it("keeps reload-recovered attachment references sendable without a thumbnail", () => {
  const restored = restoreWithdrawnDraft(run);
  expect(restored.attachments).toEqual([{ attachment: run.attachments[0], previewDataUrl: "" }]);
  expect(restored.prompt).toBe(run.request);
});

it("does not duplicate a draft already containing the original request", () => {
  expect(restoreWithdrawnDraft(run, draft(`  ${run.request}  `)).prompt).toBe(run.request);
  expect(restoreWithdrawnDraft(run, draft(" \n ")).prompt).toBe(run.request);
});

it("retains a submitted preview if the current draft has only an attachment reference", () => {
  const current = draft("", ["original"]);
  current.attachments[0]!.previewDataUrl = "";
  expect(restoreWithdrawnDraft(run, current, draft(run.request, ["original"])).attachments[0]?.previewDataUrl).toBe("data:original");
  const legacy = { ...run, taskMode: undefined };
  expect(restoreWithdrawnDraft(legacy).taskMode).toBe("auto");
});
