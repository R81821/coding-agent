import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttachmentRef } from "@harness/protocol";
import { attachmentPreviewDataUrl, SentAttachments } from "./SentAttachments.js";

const image: AttachmentRef = { id: "image", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 3,
  encryptedPath: "private/vault.enc", fileName: "截图.png", source: "clipboard", trust: "untrusted_attachment", allowedProviders: [], createdAt: "2026-10-20T00:00:00.000Z" };

describe("sent attachment messages", () => {
  it("shows sent images and ordinary file names without leaking storage paths", () => {
    const html = renderToStaticMarkup(<SentAttachments runId="run" attachments={[image, { ...image, id: "file", fileName: "需求.txt", mimeType: "text/plain" }]} />);
    expect(html).toContain("已发送附件");
    expect(html).toContain('data-attachment-id="image"');
    expect(html).toContain("加载图片");
    expect(html).toContain("截图.png");
    expect(html).toContain("需求.txt");
    expect(html).not.toContain(image.encryptedPath);
    expect(html).not.toContain("iframe");
    expect(renderToStaticMarkup(<SentAttachments runId="run" />)).toBe("");
  });

  it("constructs raster image sources only from encoded preview bytes", () => {
    expect(attachmentPreviewDataUrl({ mimeType: "image/png", base64: "YWJj" })).toBe("data:image/png;base64,YWJj");
    for (const mimeType of ["image/svg+xml", "text/html", "text/plain"]) expect(() => attachmentPreviewDataUrl({ mimeType, base64: "YWJj" })).toThrow();
    for (const base64 of ["", "http://example.test/image.png", "YWJj\n", "YWJ", "YWJj\" onerror=\"alert(1)"]) expect(() => attachmentPreviewDataUrl({ mimeType: "image/png", base64 })).toThrow();
    expect(() => attachmentPreviewDataUrl({ previewDataUrl: "file:///private/vault.enc" })).toThrow();
  });
});
