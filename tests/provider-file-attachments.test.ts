import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider, descriptor, extractFileAttachmentText, validateFileAttachment } from "@harness/providers";
import type { AttachmentRef, ModelRequest } from "@harness/protocol";

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const attachment: AttachmentRef = {
  id: "file-fixture", sha256: "a".repeat(64), mimeType: "text/plain", fileName: "组件.tsx",
  byteLength: 50, encryptedPath: "encrypted-file", source: "file", trust: "untrusted_attachment", allowedProviders: [], createdAt: "2026-10-16T00:00:00.000Z",
};

describe("file text extraction", () => {
  it("decodes Unicode source files and UTF-16 BOMs without corrupting bytes", async () => {
    const text = 'export const title = "中文";\r\n';
    expect(await extractFileAttachmentText({ bytes: Buffer.from(text), mimeType: "text/plain" })).toBe(text);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(await extractFileAttachmentText({ bytes: utf16, mimeType: "text/plain" })).toBe(text);
    expect((await validateFileAttachment({ bytes: utf16, mimeType: "text/plain" })).textTokenEstimate).toBeGreaterThan(text.length / 2);
  });

  it.each([
    ["attachment-sample.pdf", "application/pdf"],
    ["attachment-sample.docx", docxMime],
  ])("extracts actual text from %s", async (fileName, mimeType) => {
    const bytes = await readFile(new URL(`./fixtures/${fileName}`, import.meta.url));
    expect(await extractFileAttachmentText({ bytes, mimeType })).toContain("Attachment parser sample");
    expect((await validateFileAttachment({ bytes, mimeType })).textTokenEstimate).toBeGreaterThan(0);
  });

  it("rejects binary masquerading as text, bad encoding, invalid documents and over-limit text", async () => {
    await expect(extractFileAttachmentText({ bytes: Buffer.from([0, 1, 2]), mimeType: "text/plain" })).rejects.toThrow(/二进制/);
    await expect(extractFileAttachmentText({ bytes: Buffer.from([0xff]), mimeType: "text/plain" })).rejects.toThrow(/编码/);
    await expect(extractFileAttachmentText({ bytes: Buffer.from("not a document"), mimeType: docxMime })).rejects.toThrow(/DOCX/);
    await expect(extractFileAttachmentText({ bytes: Buffer.from("x".repeat(1_000_001)), mimeType: "text/plain" })).rejects.toThrow(/1 MB/);
  });

  it("validates MIME before accepting a cached document", async () => {
    const bytes = Buffer.from("cached reference text");
    await extractFileAttachmentText({ bytes, mimeType: "text/plain" });
    await expect(extractFileAttachmentText({ bytes, mimeType: "application/zip" })).rejects.toThrow(/格式/);
  });
});

describe("file attachments on model requests", () => {
  it.each([OpenAIProvider, OpenAICompatibleProvider, AnthropicProvider, GeminiProvider])("sends named untrusted text through %s alongside existing images", async Provider => {
    const model = descriptor({ providerId: "fixture", modelId: "file-model", displayName: "file-model" });
    const text = 'export const answer = "真实文件内容";';
    let body = "";
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"type":"response.completed","response":{"id":"test"}}\n\ndata: [DONE]\n\n');
    });
    const provider = new Provider({ id: "fixture", apiKey: "fixture", baseUrl: "https://example.test", models: [model],
      resolveAttachment: async ref => ({ mimeType: ref.mimeType, base64: Buffer.from(ref.id === "image" ? "image-bytes" : text).toString("base64") }), fetchImpl });
    const request: ModelRequest = { runId: "run", model, messages: [{ role: "user", content: [
      { type: "text", text: "Read the reference", trust: "user_request" },
      { type: "file", attachment },
      { type: "image", attachment: { ...attachment, id: "image", mimeType: "image/png" }, detail: "auto" },
    ] }], tools: [], maxOutputTokens: 100, parallelToolCalls: false, store: false };
    for await (const _event of provider.stream(request, new AbortController().signal)) { /* consume */ }
    const parsed = JSON.stringify(JSON.parse(body));
    expect(parsed).toContain("Untrusted file attachment");
    expect(parsed).toContain("真实文件内容");
    expect(parsed).toContain("组件.tsx");
    expect(parsed).toContain(Buffer.from("image-bytes").toString("base64"));
    expect(parsed.indexOf("Read the reference")).toBeLessThan(parsed.indexOf("Untrusted file attachment"));
    expect(parsed.indexOf("Untrusted file attachment")).toBeLessThan(parsed.indexOf(Buffer.from("image-bytes").toString("base64")));
  });

  it("denies disallowed providers before resolving contents or making network calls", async () => {
    const model = descriptor({ providerId: "fixture", modelId: "file-model", displayName: "file-model" });
    const resolveAttachment = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "fixture", baseUrl: "https://example.test", models: [model], resolveAttachment, fetchImpl });
    const request: ModelRequest = { runId: "run", model, messages: [{ role: "user", content: [{ type: "file", attachment: { ...attachment, allowedProviders: ["other"] } }] }], tools: [], maxOutputTokens: 100, parallelToolCalls: false, store: false };
    await expect(async () => { for await (const _event of provider.stream(request, new AbortController().signal)) { /* consume */ } }).rejects.toThrow(/未授权/);
    expect(resolveAttachment).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
