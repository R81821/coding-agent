import { z } from "zod";

const tabId = z.string().min(1).max(120);
const page = { tabId: tabId.optional() };
export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("new_tab"), url: z.string().max(8192).optional() }).strict(),
  z.object({ action: z.literal("switch_tab"), tabId }).strict(),
  z.object({ action: z.literal("close_tab"), tabId }).strict(),
  z.object({ action: z.literal("navigate"), ...page, url: z.string().max(8192) }).strict(),
  z.object({ action: z.literal("snapshot"), ...page }).strict(),
  z.object({ action: z.literal("screenshot"), ...page, fullPage: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("click"), ...page, selector: z.string().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("fill"), ...page, selector: z.string().min(1).max(4000), value: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal("press_key"), ...page, key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Space"]) }).strict(),
  z.object({ action: z.literal("scroll"), ...page, x: z.number().finite().min(-10000).max(10000).default(0), y: z.number().finite().min(-10000).max(10000) }).strict(),
  z.object({ action: z.literal("back"), ...page }).strict(),
  z.object({ action: z.literal("forward"), ...page }).strict(),
  z.object({ action: z.literal("reload"), ...page }).strict(),
  z.object({ action: z.literal("upload"), ...page, url: z.string().max(8192), selector: z.string().min(1).max(4000), paths: z.array(z.string().min(1).max(4096)).min(1).max(20) }).strict(),
  z.object({ action: z.literal("download"), ...page, url: z.string().max(8192), filename: z.string().max(200).optional() }).strict(),
  z.object({ action: z.literal("downloads") }).strict(),
  z.object({ action: z.literal("cancel_download"), downloadId: z.string().min(1).max(120) }).strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export interface BrowserTabState { id: string; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export interface BrowserDownloadState { id: string; tabId: string; url: string; filename: string; status: "awaiting_confirmation" | "progressing" | "completed" | "cancelled" | "interrupted"; receivedBytes: number; totalBytes: number; path?: string; error?: string }
export interface BrowserState { sessionId: string; tabs: BrowserTabState[]; activeTabId?: string; downloads: BrowserDownloadState[]; visible: boolean; revealVersion: number }
export const BrowserBridgeRequestSchema = z.object({ token: z.string(), sessionId: z.string().min(1).max(120), runId: z.string().min(1).max(120), input: BrowserActionSchema }).strict();
export const BrowserLayoutSchema = z.object({ sessionId: z.string().min(1).max(120).nullable(), visible: z.boolean(), obscured: z.boolean(), x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict();
export type BrowserLayout = z.infer<typeof BrowserLayoutSchema>;

export function browserUrl(value: string, download = false): string {
  if (value === "about:blank" && !download) return value;
  const url = new URL(value);
  const protocols = download ? ["http:", "https:", "blob:"] : ["http:", "https:", "file:"];
  if (url.username || url.password || !protocols.includes(url.protocol)) throw new Error(download ? "下载仅支持 HTTP/HTTPS 或网页 Blob 地址" : "浏览器仅支持 HTTP/HTTPS 网页或 file:// 本地文件");
  if (url.protocol === "blob:") {
    if (!["http:", "https:"].includes(new URL(url.pathname).protocol)) throw new Error("Blob 下载必须来自 HTTP/HTTPS 网页");
    browserUrl(url.pathname);
  }
  return url.href;
}
