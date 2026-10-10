import type { EncryptedBlobStore } from "@harness/persistence";
import type { ToolResult } from "@harness/tools";
import { browserScreenshotResult, MAX_SCREENSHOT_BYTES } from "@harness/tools";

/** Persist tool pixels once; events, evidence and checkpoints carry references only. */
export async function persistToolImages(result: ToolResult, blobs: EncryptedBlobStore | undefined, providerId: string, browserScreenshot: boolean): Promise<ToolResult> {
  const original = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output as Record<string, unknown> : undefined;
  const output = original ? { ...original } : undefined;
  const legacy = browserScreenshot && typeof output?.base64 === "string" ? [{ mimeType: String(output.mimeType ?? "image/png"), base64: output.base64 }] : [];
  if (browserScreenshot && output) delete output.base64;
  const images: NonNullable<ToolResult["images"]> = result.images ?? legacy;
  if (!images.length) return result;
  if (images.length > 4) throw new Error("单次工具返回图片过多");
  if (!blobs) {
    const { images: _images, ...rest } = result;
    return { ...rest, output: { ...(output ?? { result: result.output }), imageDelivery: { status: "unavailable", reason: "Image storage is unavailable; capture metadata does not prove visual inspection." } } };
  }
  const saved: NonNullable<ToolResult["images"]> = [];
  for (const image of images) {
    if ("attachment" in image) {
      // Reusing a reference cannot broaden the original provider permission or escape the store.
      if (!image.attachment.allowedProviders.includes(providerId)) throw new Error("图片未授权给当前模型服务商");
      await blobs.read(image.attachment);
      saved.push({ ...image, attachment: { ...image.attachment, trust: browserScreenshot ? "untrusted_web" : "untrusted_tool" } });
      continue;
    }
    if (browserScreenshot && image.mimeType !== "image/png") throw new Error("浏览器截图必须是 PNG 图片");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) || image.base64.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) throw new Error("工具返回的图片格式无效或过大");
    const bytes = Buffer.from(image.base64, "base64");
    const dimensions = browserScreenshot ? browserScreenshotResult(bytes, {}).output as { width: number; height: number } : image;
    for (const value of [dimensions.width, dimensions.height]) if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error("工具图片尺寸无效");
    const attachment = await blobs.put({ bytes, mimeType: image.mimeType, source: browserScreenshot ? "browser" : "file", allowedProviders: [providerId],
      ...(dimensions.width ? { width: dimensions.width } : {}), ...(dimensions.height ? { height: dimensions.height } : {}) });
    saved.push({ attachment: { ...attachment, trust: browserScreenshot ? "untrusted_web" : "untrusted_tool" }, detail: "auto" });
  }
  return { ...result, images: saved, output: { ...(output ?? { result: result.output }), attachments: saved.flatMap(image => "attachment" in image ? [image.attachment] : []) } };
}
