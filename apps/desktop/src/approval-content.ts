export interface ApprovalField { label: string; text: string }
const labels: Record<string, string> = { content: "正文", command: "命令", stdin: "标准输入", patch: "补丁" };
/** Unwrap presentation envelopes only; command/content strings are always literal. */
export function approvalFields(input: unknown): ApprovalField[] {
 if (typeof input === "string") {
  try {
   const parsed: unknown = JSON.parse(input);
   if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "content" in parsed) return approvalFields(parsed);
  } catch { /* Ordinary text is not JSON. */ }
  return [{ label: "正文", text: input }];
 }
 const fields: ApprovalField[] = [];
 function visit(value: unknown, label: string, depth: number) {
  if (depth > 20) { fields.push({label, text: JSON.stringify(value) ?? String(value)}); return; }
  if (value && typeof value === "object") {
   const entries = Object.entries(value);
   if (!entries.length) { fields.push({ label, text: Array.isArray(value) ? "空列表" : "无参数" }); return; }
   entries.sort(([a], [b]) => Number(b === "content") - Number(a === "content"));
   for (const [key, child] of entries) visit(child, label ? `${label} · ${labels[key] ?? key}` : labels[key] ?? key, depth + 1);
  } else fields.push({label: label || "正文", text: value === null ? "null" : String(value)});
 }
 visit(input, "", 0);
 return fields;
}
