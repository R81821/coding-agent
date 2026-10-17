// Shared metadata only. Content validation belongs to the local attachment ingestion boundary.
export const MAX_ATTACHMENT_BYTES = 30_000_000;

const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "csv", "tsv", "json", "jsonc", "jsonl", "ndjson",
  "xml", "html", "htm", "css", "scss", "sass", "less", "svg", "yaml", "yml", "toml", "ini",
  "conf", "config", "cfg", "log", "env", "gitignore", "gitattributes", "npmrc", "dockerignore",
  "editorconfig", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "ipynb", "rb",
  "go", "rs", "java", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "php", "sh", "bash", "zsh",
  "ps1", "psm1", "psd1", "bat", "cmd", "r", "lua", "sql", "swift", "kt", "kts", "dart", "vue",
  "svelte", "graphql", "gql", "proto", "diff", "patch", "rst", "tex", "bib", "properties",
]);
const TEXT_FILE_NAMES = new Set(["dockerfile", "makefile", "cmakelists.txt", "license", "readme"]);

/** A display name, never a filesystem path or authority to read another local file. */
export function attachmentFileName(value: string): string | undefined {
  const leaf = value.replace(/\\/g, "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!leaf || leaf === "." || leaf === "..") return undefined;
  return leaf.slice(0, 255);
}

/** Canonical MIME for the supported image, document and source-code picker formats. */
export function attachmentMimeTypeForFileName(value: string): string | undefined {
  const name = attachmentFileName(value)?.toLowerCase();
  if (!name) return undefined;
  const extension = name.split(".").at(-1) ?? "";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return TEXT_FILE_EXTENSIONS.has(extension) || TEXT_FILE_NAMES.has(name) ? "text/plain" : undefined;
}
