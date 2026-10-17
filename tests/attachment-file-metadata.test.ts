import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentRefSchema, ContentPartSchema, DaemonRequestSchema, attachmentFileName, attachmentMimeTypeForFileName } from "@harness/protocol";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("file attachment metadata", () => {
  it("accepts text, code and document selection without treating an unsupported binary as text", () => {
    expect(attachmentMimeTypeForFileName("C:\\Documents\\组件.tsx")).toBe("text/plain");
    expect(attachmentMimeTypeForFileName("/documents/REPORT.PDF")).toBe("application/pdf");
    expect(attachmentMimeTypeForFileName("notes.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(attachmentMimeTypeForFileName(".gitignore")).toBe("text/plain");
    expect(attachmentMimeTypeForFileName("Dockerfile")).toBe("text/plain");
    expect(attachmentMimeTypeForFileName("module.wasm")).toBeUndefined();
    expect(attachmentMimeTypeForFileName("program.exe")).toBeUndefined();
    expect(attachmentFileName("C:\\private\\..\\documents\\report.txt\u0000")).toBe("report.txt");
    expect(attachmentFileName("../")).toBeUndefined();
  });

  it("persists exact file bytes and the sanitized name in encrypted storage and a file content part", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-file-metadata-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "attachment-test-passphrase");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    try {
      const blobs = new EncryptedBlobStore(join(root, "blobs"), vault);
      const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("实际文件内容\r\nexport const sample = 42;", "utf16le")]);
      const fileName = attachmentFileName("C:\\private\\参考代码.tsx")!;
      const request = DaemonRequestSchema.parse({ id: "upload", method: "attachment.put", params: {
        base64: bytes.toString("base64"), mimeType: "text/plain", fileName, source: "file", allowedProviders: ["selected-provider"],
      } });
      expect(request.method).toBe("attachment.put");
      const attachment = await blobs.put({ bytes, mimeType: "text/plain", fileName, source: "file", allowedProviders: ["selected-provider"] });
      database.saveAttachment(attachment);
      expect(database.getAttachment(attachment.id)).toEqual(attachment);
      expect(AttachmentRefSchema.parse(attachment)).toMatchObject({ fileName: "参考代码.tsx", trust: "untrusted_attachment", allowedProviders: ["selected-provider"] });
      expect(ContentPartSchema.parse({ type: "file", attachment })).toMatchObject({ type: "file", attachment: { fileName } });
      expect(await blobs.read(attachment)).toEqual(bytes);
      expect((await readFile(attachment.encryptedPath)).includes(bytes)).toBe(false);
      expect((await readFile(join(root, "harness.sqlite"))).includes(Buffer.from(fileName))).toBe(false);
    } finally {
      database.close();
      vault.dispose();
    }
  });
});
