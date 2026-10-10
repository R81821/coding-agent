import { describe, expect, it, vi } from "vitest";
import type { BrowserAction } from "@harness/protocol";
import { BrowserScreenshotCapture, browserScreenshotBlob, type ScreenshotPage, type ScreenshotState } from "./browser-screenshot.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVq0AAAAASUVORK5CYII=";
const page: ScreenshotPage = { sessionId: "session-a", tabId: "tab-a", url: "file:///D:/project/index.html", title: "本地页面" };
const result = (target = page) => ({ output: { tabId: target.tabId, url: target.url, title: target.title, mimeType: "image/png", width: 1, height: 1 }, images: [{ mimeType: "image/png", base64: png }] });

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function captureFixture(command: (id: string, action: BrowserAction) => Promise<unknown> = async () => result()) {
  const states: ScreenshotState[] = [];
  const urls = { createObjectURL: vi.fn((_blob: Blob) => "blob:browser-capture"), revokeObjectURL: vi.fn() };
  const capture = new BrowserScreenshotCapture(command, state => states.push(state), urls);
  capture.setPage(page);
  return { capture, states, urls, latest: () => states.at(-1)! };
}

describe("browser screenshot PNG boundary", () => {
  it("decodes actual PNG bytes and dimensions from image output", async () => {
    const image = browserScreenshotBlob(result(), page);
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
    expect(image.blob.type).toBe("image/png");
    expect(Buffer.from(await image.blob.arrayBuffer()).toString("base64")).toBe(png);
  });

  it("accepts the older desktop capture output for preview compatibility", () => {
    expect(browserScreenshotBlob({ output: { ...result().output, base64: png } }, page).width).toBe(1);
  });

  it.each([
    { ...result(), output: { ...result().output, tabId: "another-tab" } },
    { ...result(), output: { ...result().output, url: "https://changed.example" } },
    { images: result().images },
  ])("rejects images without matching current page provenance", value => {
    expect(() => browserScreenshotBlob(value, page)).toThrow("网页已变化");
  });

  it.each([
    { mimeType: "image/svg+xml", base64: Buffer.from("<svg onload='alert(1)'/>").toString("base64") },
    { mimeType: "image/png", base64: "data:image/png;base64," + png },
    { mimeType: "image/png", base64: "not valid base64" },
    { mimeType: "image/png", base64: Buffer.from("<script>capture</script>").toString("base64") },
  ])("never turns page URLs or non-PNG payloads into preview sources", value => {
    expect(() => browserScreenshotBlob({ output: result().output, images: [value] }, page)).toThrow("有效的 PNG");
  });

  it("rejects PNG headers with an empty image size", () => {
    const bytes = Buffer.from(png, "base64");
    bytes.writeUInt32BE(0, 16);
    expect(() => browserScreenshotBlob({ output: result().output, images: [{ mimeType: "image/png", base64: bytes.toString("base64") }] }, page)).toThrow("截图尺寸无效");
  });
});

describe("browser screenshot preview lifecycle", () => {
  it("captures the explicit active tab once, shows a downloadable PNG and releases it when closed", async () => {
    const request = deferred();
    const command = vi.fn(() => request.promise);
    const { capture, latest, urls } = captureFixture(command);
    const first = capture.capture();
    await capture.capture();
    expect(command).toHaveBeenCalledExactlyOnceWith(page.sessionId, { action: "screenshot", tabId: page.tabId });
    expect(latest().capturing).toBe(true);
    request.resolve(result());
    await first;
    expect(latest()).toMatchObject({ capturing: false, preview: { objectUrl: "blob:browser-capture", pageUrl: page.url, title: page.title, width: 1, height: 1 } });
    expect(latest().preview?.filename).toMatch(/^browser-screenshot-\d+\.png$/);
    expect(urls.createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    capture.close();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:browser-capture");
    expect(latest()).toEqual({ capturing: false });
  });

  it.each([
    { ...page, sessionId: "session-b" },
    { ...page, tabId: "tab-b" },
    { ...page, url: "https://new.example" },
    undefined,
  ])("discards a late capture after the conversation or page changes", async target => {
    const request = deferred();
    const { capture, latest, urls } = captureFixture(() => request.promise);
    const pending = capture.capture();
    capture.setPage(target);
    request.resolve(result());
    await pending;
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(latest()).toEqual({ capturing: false });
  });

  it("ignores an old rejection while a newer page capture completes", async () => {
    const old = deferred(), current = deferred();
    const command = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { capture, latest, urls } = captureFixture(command);
    const first = capture.capture();
    const newPage = { ...page, tabId: "tab-b" };
    capture.setPage(newPage);
    const second = capture.capture();
    old.reject(new Error("旧页面已关闭"));
    await first;
    expect(latest()).toEqual({ capturing: true });
    current.resolve(result(newPage));
    await second;
    expect(latest().preview?.pageUrl).toBe(newPage.url);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("releases a finished preview on page changes and on component disposal", async () => {
    const { capture, urls } = captureFixture();
    await capture.capture();
    capture.setPage({ ...page, sessionId: "session-b" });
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
    await capture.capture();
    capture.dispose();
    capture.dispose();
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
    await capture.capture();
    expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("does not create an object URL or update state after disposal with a pending capture", async () => {
    const request = deferred();
    const { capture, urls, states } = captureFixture(() => request.promise);
    const pending = capture.capture();
    capture.dispose();
    const before = states.length;
    request.resolve(result());
    await pending;
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(states).toHaveLength(before);
  });

  it("surfaces capture failures and permits a fresh successful attempt", async () => {
    const command = vi.fn().mockRejectedValueOnce(new Error("捕获页面失败")).mockResolvedValueOnce(result());
    const { capture, latest } = captureFixture(command);
    await capture.capture();
    expect(latest()).toEqual({ capturing: false, error: "捕获页面失败" });
    await capture.capture();
    expect(latest().preview).toBeDefined();
    expect(latest().error).toBeUndefined();
  });
});
