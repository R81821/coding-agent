import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentRefSchema, MAX_ATTACHMENT_BYTES } from "@harness/protocol";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { validateFileAttachment } from "@harness/providers";
import { ingestUploadedAttachment, type AttachmentIngestTarget } from "../apps/daemon/src/attachment-ingest.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function fakeTarget() {
  const put = vi.fn<AttachmentIngestTarget["blobs"]["put"]>(async input => ({
    id: "fixture", sha256: "a".repeat(64), byteLength: input.bytes.byteLength, mimeType: input.mimeType,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    ...(input.textTokenEstimate !== undefined ? { textTokenEstimate: input.textTokenEstimate } : {}),
    source: input.source, trust: "untrusted_attachment", allowedProviders: input.allowedProviders,
    encryptedPath: "encrypted-fixture", createdAt: "2026-10-16T00:00:00.000Z",
  }));
  return { blobs: { put }, database: { saveAttachment: vi.fn() } };
}

describe("daemon attachment ingestion", () => {
  it("validates source files, encrypts exact bytes and persists names and text budget metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-file-ingest-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "attachment-test-passphrase");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    try {
      const blobs = new EncryptedBlobStore(join(root, "blobs"), vault);
      const bytes = Buffer.from('export const title = "文件上传";\r\n');
      const attachment = await ingestUploadedAttachment({
        base64: bytes.toString("base64"), mimeType: "text/plain", fileName: "C:\\Documents\\组件.tsx",
        source: "file", allowedProviders: ["selected-provider"],
      }, { blobs, database }, validateFileAttachment);
      expect(AttachmentRefSchema.parse(attachment)).toMatchObject({
        mimeType: "text/plain", fileName: "组件.tsx", trust: "untrusted_attachment", allowedProviders: ["selected-provider"],
      });
      expect(attachment.textTokenEstimate).toBeGreaterThan(0);
      expect(database.getAttachment(attachment.id)).toEqual(attachment);
      expect(await blobs.read(attachment)).toEqual(bytes);
      expect((await readFile(attachment.encryptedPath)).includes(bytes)).toBe(false);
    } finally {
      database.close();
      vault.dispose();
    }
  });

  it("accepts UTF-16 file contents through the same validation boundary", async () => {
    const target = fakeTarget();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文配置\r\nkey=value\r\n", "utf16le")]);
    const attachment = await ingestUploadedAttachment({
      base64: bytes.toString("base64"), mimeType: "text/plain", fileName: "配置.ini", source: "file", allowedProviders: [],
    }, target, validateFileAttachment);
    expect(attachment.textTokenEstimate).toBeGreaterThan(0);
    expect(target.blobs.put.mock.calls[0]?.[0].bytes).toEqual(bytes);
  });

  it.each([
    ["attachment-sample.pdf", "application/pdf"],
    ["attachment-sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("validates a real %s document before persisting the original bytes", async (fileName, mimeType) => {
    const target = fakeTarget();
    const bytes = await readFile(new URL(`./fixtures/${fileName}`, import.meta.url));
    const attachment = await ingestUploadedAttachment({
      base64: bytes.toString("base64"), mimeType, fileName, source: "file", allowedProviders: ["document-provider"],
    }, target, validateFileAttachment);
    expect(attachment).toMatchObject({ fileName, mimeType, trust: "untrusted_attachment", allowedProviders: ["document-provider"] });
    expect(attachment.textTokenEstimate).toBeGreaterThan(0);
    expect(target.blobs.put.mock.calls[0]?.[0].bytes).toEqual(bytes);
    expect(target.database.saveAttachment).toHaveBeenCalledWith(attachment);
  });

  it.each([
    { bytes: Buffer.from([0, 1, 2, 3, 0xff]), mimeType: "application/octet-stream", fileName: "app.exe" },
    { bytes: Buffer.from([0, 1, 2, 3, 0xff]), mimeType: "text/plain", fileName: "renamed.txt" },
    { bytes: Buffer.from("%PDF-1.7\ninvalid document"), mimeType: "application/pdf", fileName: "broken.pdf" },
  ])("rejects unsupported or malformed $fileName before creating an attachment", async input => {
    const target = fakeTarget();
    await expect(ingestUploadedAttachment({
      base64: input.bytes.toString("base64"), mimeType: input.mimeType, fileName: input.fileName, source: "file", allowedProviders: [],
    }, target, validateFileAttachment)).rejects.toThrow();
    expect(target.blobs.put).not.toHaveBeenCalled();
    expect(target.database.saveAttachment).not.toHaveBeenCalled();
  });

  it("retains image MIME validation and does not send image bytes to the document parser", async () => {
    const target = fakeTarget();
    const validate = vi.fn(async () => ({ textTokenEstimate: 9 }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yXfoAAAAASUVORK5CYII=", "base64");
    const input = { base64: png.toString("base64"), mimeType: "image/png", fileName: "preview.png", source: "file" as const, allowedProviders: ["vision"] };
    const attachment = await ingestUploadedAttachment(input, target, validate);
    expect(attachment).toMatchObject({ mimeType: "image/png", fileName: "preview.png" });
    expect(attachment.textTokenEstimate).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    await expect(ingestUploadedAttachment({ ...input, mimeType: "image/jpeg" }, target, validate)).rejects.toThrow(/MIME/);
    await expect(ingestUploadedAttachment({ ...input, mimeType: "text/plain" }, target, validate)).rejects.toThrow(/MIME/);
    expect(target.blobs.put).toHaveBeenCalledTimes(1);
  });

  it.each(["", "YQ", "YQ==\n", "YR==", "!?=="])("rejects invalid encoded payload %j before validation or persistence", async base64 => {
    const target = fakeTarget();
    const validate = vi.fn(async () => ({ textTokenEstimate: 1 }));
    await expect(ingestUploadedAttachment({ base64, mimeType: "text/plain", source: "file", allowedProviders: [] }, target, validate)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    expect(target.blobs.put).not.toHaveBeenCalled();
  });

  it("rejects over-limit uploads before decoding them", async () => {
    const target = fakeTarget();
    const validate = vi.fn(async () => ({ textTokenEstimate: 1 }));
    await expect(ingestUploadedAttachment({
      base64: "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4), mimeType: "text/plain", source: "file", allowedProviders: [],
    }, target, validate)).rejects.toThrow(/30 MB/);
    expect(validate).not.toHaveBeenCalled();
    expect(target.blobs.put).not.toHaveBeenCalled();
  });
});
