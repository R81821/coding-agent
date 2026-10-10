import type { ToolResult } from "./types.js";

export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
export const MAX_SCREENSHOT_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function fullPageScreenshotClip(size: { x?: number; y?: number; width: number; height: number }) {
  const width = Math.ceil(size.width), height = Math.ceil(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_SCREENSHOT_PIXELS) throw new Error("整页截图尺寸过大或为空，请截取当前可视区域");
  return { x: 0, y: 0, width, height, scale: 1 };
}

/** Keep pixels separate from JSON evidence so screenshots reach the vision input. */
export function browserScreenshotResult(bytes: Buffer, metadata: { tabId?: string; url?: string; title?: string; fullPage?: boolean }): ToolResult {
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("截图超过 12 MiB，请缩小页面或截取当前可视区域");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("浏览器未返回有效的 PNG 截图，请等待页面显示后重试");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_SCREENSHOT_PIXELS) throw new Error("截图尺寸过大或为空，请截取当前可视区域");
  return {
    output: { ...metadata, mimeType: "image/png", width, height, byteLength: bytes.length, scope: metadata.fullPage ? "full_page" : "viewport", capturedAt: new Date().toISOString() },
    images: [{ mimeType: "image/png", base64: bytes.toString("base64"), width, height }],
  };
}
