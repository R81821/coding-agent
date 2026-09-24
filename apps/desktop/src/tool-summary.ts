import type { ToolCallOrigin } from "@harness/protocol";
import { parseDiff } from "./code-changes.js";

export type ToolSummary = {
  label: string;
  detail: string;
  kind: "file" | "command" | "search" | "generic";
};

export type ToolActivity = {
  verb: "已运行" | "编辑了文件";
  detail: string;
};

const stringValue = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? input[key] as string : "";

export function toolSummary(name: string, rawInput: unknown, origin?: ToolCallOrigin): ToolSummary {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  // Remote tools carry a namespaced name that means nothing to the user. The call row
  // renders `detail`, not `label`, so the human-readable identity must go in `detail`.
  if (origin) return { label: origin.toolName, detail: `${origin.serverName} · ${origin.toolName}`, kind: "generic" };
  if (["read_file", "read_range", "write_file"].includes(name)) {
    return { label: name, detail: stringValue(input, "path"), kind: "file" };
  }
  if (name === "apply_patch") {
    const patch = stringValue(input, "patch");
    const customFiles = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
    const files = customFiles.length ? customFiles : parseDiff(patch).map(file => file.path);
    return { label: name, detail: [...new Set(files)].join(", "), kind: "file" };
  }
  if (name === "terminal" || name === "bash") {
    return { label: name, detail: stringValue(input, "command"), kind: "command" };
  }
  if (name === "search_text") {
    const query = stringValue(input, "query");
    const path = stringValue(input, "path");
    return { label: name, detail: [query, path].filter(Boolean).join(" · "), kind: "search" };
  }
  if (name === "git_diff") return { label: name, detail: "代码变更检查", kind: "generic" };
  return { label: name, detail: "", kind: "generic" };
}

export function toolActivity(name: string, rawInput: unknown): ToolActivity {
  const summary = toolSummary(name, rawInput);
  return {
    verb: summary.kind === "file" && ["apply_patch", "write_file"].includes(name) ? "编辑了文件" : "已运行",
    detail: summary.detail || summary.label,
  };
}
