import { createHash } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "@harness/protocol";

export interface FileAttachmentInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_EXTRACTED_FILE_BYTES = 1_000_000;
const MAX_PDF_PAGES = 200;
const extractedTextCache = new Map<string, string>();

/** Extract only document text; uploaded contents never become application instructions. */
export async function extractFileAttachmentText(input: FileAttachmentInput): Promise<string> {
  const { bytes } = input;
  const mimeType = input.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("文件不能为空，且不能超过 30 MB");
  if (!mimeType.startsWith("text/") && mimeType !== "application/pdf" && mimeType !== DOCX_MIME) {
    throw new Error("暂不支持此文件格式，请上传文本、代码、PDF 或 DOCX 文件");
  }
  const key = `${mimeType}:${createHash("sha256").update(bytes).digest("hex")}`;
  const cached = extractedTextCache.get(key);
  if (cached !== undefined) return cached;
  let text: string;
  if (mimeType.startsWith("text/")) {
    try {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw new Error("无法读取文件编码，请将文本文件保存为 UTF-8 或带 BOM 的 UTF-16");
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error("此文件包含二进制数据，无法作为文本上传");
  } else if (mimeType === "application/pdf") {
    const { getDocumentProxy } = await import("unpdf");
    let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      // Copy the buffer: PDF.js may transfer/detach its input during parsing.
      document = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false });
      if (document.numPages > MAX_PDF_PAGES) throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页，请拆分后上传`);
      const pages: string[] = [];
      let size = 0;
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        const value = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        size += Buffer.byteLength(value) + 2;
        if (size > MAX_EXTRACTED_FILE_BYTES) throw new Error("文件文字超过 1 MB，请拆分后上传");
        pages.push(value);
        page.cleanup();
      }
      text = pages.join("\n\n");
      if (!text.trim()) throw new Error("PDF 没有可提取的文字；扫描件请改为上传图片");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`无法读取 PDF：${reason}`);
    } finally {
      await document?.loadingTask.destroy();
    }
  } else {
    try {
      const { default: mammoth } = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } catch {
      throw new Error("无法读取 DOCX，请确认文件完整且未加密");
    }
    if (!text.trim()) throw new Error("DOCX 没有可提取的文字");
  }
  if (Buffer.byteLength(text) > MAX_EXTRACTED_FILE_BYTES) throw new Error("文件文字超过 1 MB，请拆分后上传");
  if (extractedTextCache.size >= 16) extractedTextCache.delete(extractedTextCache.keys().next().value!);
  extractedTextCache.set(key, text);
  return text;
}

export async function validateFileAttachment(input: FileAttachmentInput): Promise<{ textTokenEstimate: number }> {
  const text = await extractFileAttachmentText(input);
  const asciiLength = text.match(/[\x00-\x7f]/g)?.length ?? 0;
  return { textTokenEstimate: Math.max(1, Math.ceil(asciiLength / 2 + Buffer.byteLength(text) - asciiLength)) };
}
