import { describe, expect, it, vi } from "vitest";
import type { EncryptedBlobStore } from "@harness/persistence";
import { BrowserActionSchema, type AttachmentRef } from "@harness/protocol";
import { browserScreenshotResult, fullPageScreenshotClip, MAX_SCREENSHOT_BYTES } from "@harness/tools";
import { persistToolImages } from "../packages/core/src/tool-images.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

describe("browser screenshot boundaries", () => {
  it("accepts explicit viewport/whole-page requests without exposing arbitrary capture code", () => {
    expect(BrowserActionSchema.parse({ action: "screenshot", tabId: "tab", fullPage: true })).toEqual({ action: "screenshot", tabId: "tab", fullPage: true });
    for (const extra of [{ fullPage: "true" }, { path: "../secret.png" }, { expression: "process.env" }]) expect(BrowserActionSchema.safeParse({ action: "screenshot", ...extra }).success).toBe(false);
  });

  it("keeps binary PNG outside text evidence and records actual PNG dimensions", () => {
    const result = browserScreenshotResult(png, { url: "file:///preview.html", fullPage: true });
    expect(result.output).toMatchObject({ url: "file:///preview.html", mimeType: "image/png", width: 1, height: 1, scope: "full_page", byteLength: png.length });
    expect(JSON.stringify(result.output)).not.toContain(png.toString("base64"));
    expect(result.images).toHaveLength(1);
  });

  it("rejects empty/invalid/oversized screenshot images before they reach the pipe", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), Buffer.alloc(MAX_SCREENSHOT_BYTES + 1)]) expect(() => browserScreenshotResult(bytes, {})).toThrow();
    const excessive = Buffer.from(png); excessive.writeUInt32BE(20000, 20);
    expect(() => browserScreenshotResult(excessive, {})).toThrow("尺寸");
  });

  it("bounds whole-page captures without mutating viewport dimensions", () => {
    expect(fullPageScreenshotClip({ width: 440.1, height: 1200.4 })).toEqual({ x: 0, y: 0, width: 441, height: 1201, scale: 1 });
    for (const size of [{ width: 1000, height: Infinity }, { width: 0, height: 100 }, { width: 9000, height: 9000 }, { width: 100, height: 20000 }]) expect(() => fullPageScreenshotClip(size)).toThrow();
  });

  it("supports older desktop screenshot responses without leaving base64 in evidence", async () => {
    const put = vi.fn(async () => ({ id: "stored", trust: "untrusted_attachment", allowedProviders: ["model-provider"] }));
    const blobs = { put } as unknown as EncryptedBlobStore;
    const result = await persistToolImages({ output: { url: "file:///preview.html", mimeType: "image/png", base64: png.toString("base64") } }, blobs, "model-provider", true);
    expect(result.output).not.toHaveProperty("base64");
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ bytes: png, source: "browser", allowedProviders: ["model-provider"], width: 1, height: 1 }));
    expect(result.images).toEqual([{ attachment: expect.objectContaining({ id: "stored", trust: "untrusted_web" }), detail: "auto" }]);
  });

  it("does not broaden permissions when a tool reuses an existing attachment", async () => {
    const read = vi.fn();
    const blobs = { read } as unknown as EncryptedBlobStore;
    const attachment = { id: "existing", allowedProviders: ["original-provider"] } as AttachmentRef;
    await expect(persistToolImages({ output: {}, images: [{ attachment }] }, blobs, "other-provider", true)).rejects.toThrow("未授权");
    expect(read).not.toHaveBeenCalled();
  });

  it("reports unavailable pixel delivery explicitly when no encrypted store is configured", async () => {
    const result = await persistToolImages(browserScreenshotResult(png, {}), undefined, "provider", true);
    expect(result).not.toHaveProperty("images");
    expect(result.output).toMatchObject({ imageDelivery: { status: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
  });
});
