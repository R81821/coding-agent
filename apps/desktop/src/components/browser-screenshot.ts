import type { BrowserAction } from "@harness/protocol";

export interface ScreenshotPage {
  sessionId: string;
  tabId: string;
  url: string;
  title: string;
}

export interface ScreenshotPreview {
  objectUrl: string;
  filename: string;
  pageUrl: string;
  title: string;
  width: number;
  height: number;
}

export interface ScreenshotState {
  capturing: boolean;
  preview?: ScreenshotPreview;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Decode only PNG bytes from the capture response, never a page-controlled URL. */
export function browserScreenshotBlob(result: unknown, page: ScreenshotPage): { blob: Blob; width: number; height: number } {
  const response = record(result);
  if (typeof response?.error === "string") throw new Error(response.error);
  const output = record(response?.output);
  if (output?.tabId !== page.tabId || output.url !== page.url) throw new Error("网页已变化，请重新截图");
  const image = Array.isArray(response?.images) ? response.images.map(record).find(value => value?.mimeType === "image/png") : undefined;
  const base64 = image?.base64 ?? output.base64;
  if ((image?.mimeType ?? output.mimeType) !== "image/png" || typeof base64 !== "string" || !base64.length || base64.length > 45_000_000 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("浏览器未返回有效的 PNG 截图");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte) || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("浏览器未返回有效的 PNG 截图");
  const header = new DataView(bytes.buffer);
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height) throw new Error("截图尺寸无效");
  return { blob: new Blob([bytes], { type: "image/png" }), width, height };
}

/** Owns preview lifetimes and ignores captures from a page that has since changed. */
export class BrowserScreenshotCapture {
  private page: ScreenshotPage | undefined;
  private version = 0;
  private disposed = false;
  private state: ScreenshotState = { capturing: false };

  constructor(
    private readonly command: (sessionId: string, input: BrowserAction) => Promise<unknown>,
    private readonly changed: (state: ScreenshotState) => void,
    private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  ) {}

  setPage(page: ScreenshotPage | undefined): void {
    if (this.disposed) return;
    const previous = this.page;
    this.page = page;
    if (previous?.sessionId === page?.sessionId && previous?.tabId === page?.tabId && previous?.url === page?.url) return;
    this.version++;
    this.releasePreview();
    this.update({ capturing: false });
  }

  async capture(): Promise<void> {
    const page = this.page;
    if (this.disposed || !page || this.state.capturing) return;
    const version = ++this.version;
    this.releasePreview();
    this.update({ capturing: true });
    try {
      const result = await this.command(page.sessionId, { action: "screenshot", tabId: page.tabId });
      if (this.disposed || version !== this.version) return;
      const { blob, width, height } = browserScreenshotBlob(result, page);
      const objectUrl = this.urls.createObjectURL(blob);
      this.update({ capturing: false, preview: { objectUrl, filename: `browser-screenshot-${Date.now()}.png`, pageUrl: page.url, title: page.title, width, height } });
    } catch (error) {
      if (!this.disposed && version === this.version) this.update({ capturing: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  close(): void {
    if (this.disposed) return;
    this.version++;
    this.releasePreview();
    this.update({ capturing: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.version++;
    this.releasePreview();
  }

  private releasePreview(): void {
    if (this.state.preview) this.urls.revokeObjectURL(this.state.preview.objectUrl);
  }

  private update(state: ScreenshotState): void {
    this.state = state;
    this.changed(state);
  }
}
