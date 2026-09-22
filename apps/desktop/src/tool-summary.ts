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

export function toolSummary(name: string, rawInput: unknown): ToolSummary {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  if (["read_file", "read_range", "write_file"].includes(name)) {
    return { label: name, detail: stringValue(input, "path"), kind: "file" };
  }
  if (name === "apply_patch") {
    const patch = stringValue(input, "patch");
    const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
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
    verb: summary.kind === "file" && name === "apply_patch" ? "编辑了文件" : "已运行",
    detail: summary.detail || summary.label,
  };
}
