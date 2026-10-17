import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { AttachmentRef } from "@harness/protocol";
import { MAX_ATTACHMENT_BYTES } from "@harness/protocol";
import type { DesktopAttachment } from "./preload.js";

type Packet = { id: string; method: string; params: { base64: string; mimeType: string; fileName?: string; source: AttachmentRef["source"]; allowedProviders: string[] } };
type API = {
  chooseFiles(providers: string[]): Promise<DesktopAttachment[]>;
  chooseImages(providers: string[]): Promise<DesktopAttachment[]>;
  putFile(base64: string, mimeType: string, name: string, source: "file" | "clipboard", providers: string[]): Promise<DesktopAttachment>;
  putImage(base64: string, mimeType: string, source: "file" | "clipboard" | "screenshot", providers: string[], name?: string): Promise<DesktopAttachment>;
};
const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...input: unknown[]) => unknown>(), requests: [] as Packet[], paths: [] as string[], canceled: false, api: undefined as API | undefined }));
vi.mock("electron", () => ({
  app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise<void>(() => {}), on: vi.fn() },
  BrowserWindow: class {}, desktopCapturer: {}, Menu: {}, nativeImage: {}, safeStorage: {}, shell: {}, screen: {}, Tray: class {},
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: fixture.canceled, filePaths: fixture.paths })) },
  ipcMain: { handle: (name: string, handler: (...input: unknown[]) => unknown) => fixture.handlers.set(name, handler) },
  ipcRenderer: { invoke: (name: string, ...input: unknown[]) => fixture.handlers.get(name)?.({}, ...input) },
  contextBridge: { exposeInMainWorld: (_name: string, api: API) => { fixture.api = api; } },
}));
vi.mock("./output-pipe-guard.js", () => ({ guardProcessOutput: vi.fn() }));
vi.mock("./browser-host.js", () => ({ DesktopBrowserHost: class {} }));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    setEncoding() { return this; }
    end() { return this; }
    destroy() { return this; }
    write(value: string) {
      const request = JSON.parse(value) as Packet;
      fixture.requests.push(request);
      const bytes = Buffer.from(request.params.base64, "base64");
      const attachment: AttachmentRef = { id: `attachment-${fixture.requests.length}`, sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: request.params.mimeType, byteLength: bytes.byteLength, encryptedPath: "fixture/encrypted", source: request.params.source,
        trust: "untrusted_attachment", allowedProviders: request.params.allowedProviders, createdAt: "2026-10-16T00:00:00.000Z",
        ...(request.params.fileName ? { fileName: request.params.fileName } : {}) };
      queueMicrotask(() => this.emit("data", JSON.stringify({ id: request.id, ok: true, result: attachment }) + "\n"));
      return true;
    }
  }
  return { ...actual, connect: () => { const socket = new Socket(); queueMicrotask(() => socket.emit("connect")); return socket; } };
});

let directory: string;
let api: API;
let png: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-desktop-attachments-"));
  const { default: sharp } = await import("sharp");
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#335577" } }).png().toBuffer();
  await import("./main.js");
  await import("./preload.js");
  api = fixture.api!;
});
beforeEach(() => { fixture.requests.length = 0; fixture.paths = []; fixture.canceled = false; });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("desktop file attachment IPC", () => {
  it("chooses files and forwards exact bytes, canonical MIME, safe filename and provider scope to the daemon", async () => {
    const bytes = Buffer.from('export const 中文 = "original bytes";\r\n');
    const path = join(directory, "component.tsx");
    await writeFile(path, bytes);
    fixture.paths = [path];
    const [item] = await api.chooseFiles(["selected-provider"]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ method: "attachment.put", params: { base64: bytes.toString("base64"), mimeType: "text/plain", fileName: "component.tsx", source: "file", allowedProviders: ["selected-provider"] } });
    expect(item).toMatchObject({ previewDataUrl: "", fileName: "component.tsx", attachment: { fileName: "component.tsx", mimeType: "text/plain", byteLength: bytes.byteLength, trust: "untrusted_attachment" } });
  });

  it.each(["notes.txt", "reference.pdf", "spec.docx"])("puts dropped %s without changing its bytes or trusting browser MIME", async name => {
    const bytes = Buffer.from("original uploaded file bytes");
    const item = await api.putFile(bytes.toString("base64"), "application/octet-stream", `C:\\Users\\Example\\${name}`, "clipboard", ["local"]);
    expect(fixture.requests[0]?.params.base64).toBe(bytes.toString("base64"));
    expect(fixture.requests[0]?.params.mimeType).toBe(name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain");
    expect(item.attachment.fileName).toBe(name);
    expect(item.attachment.source).toBe("clipboard");
  });

  it("uses image normalization and persists filenames for chosen and dropped images", async () => {
    const path = join(directory, "preview.png");
    await writeFile(path, png);
    fixture.paths = [path];
    const [chosen] = await api.chooseImages(["vision"]);
    const dropped = await api.putImage(png.toString("base64"), "image/png", "file", ["vision"], "C:\\Pictures\\dropped.png");
    const generic = await api.putFile(png.toString("base64"), "application/octet-stream", "generic.png", "file", ["vision"]);
    expect(fixture.requests.map(request => request.params.fileName)).toEqual(["preview.png", "dropped.png", "generic.png"]);
    for (const item of [chosen!, dropped, generic]) {
      expect(item.previewDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(item.attachment.mimeType).toBe("image/png");
      expect(item.attachment.fileName).toBe(item.fileName);
    }
  });

  it("rejects files over 30 MB, empty files and unsupported formats before daemon persistence", async () => {
    const oversized = join(directory, "oversized.txt");
    await writeFile(oversized, "x");
    await truncate(oversized, MAX_ATTACHMENT_BYTES + 1);
    fixture.paths = [oversized];
    await expect(api.chooseFiles([])).rejects.toThrow("30 MB");
    const empty = join(directory, "empty.txt");
    await writeFile(empty, "");
    fixture.paths = [empty];
    await expect(api.chooseFiles([])).rejects.toThrow("1 字节");
    await expect(api.putFile("YQ==", "text/plain", "program.exe", "file", [])).rejects.toThrow("不支持此文件格式");
    expect(fixture.requests).toHaveLength(0);
  });

  it.each(["", "YQ", "YQ==\n", "YR=="])("rejects malformed encoded uploads %j before daemon persistence", async value => {
    await expect(api.putFile(value, "text/plain", "notes.txt", "file", [])).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  it("returns an empty selection when the chooser is canceled", async () => {
    fixture.canceled = true;
    expect(await api.chooseFiles([])).toEqual([]);
    expect(fixture.requests).toHaveLength(0);
  });
});
