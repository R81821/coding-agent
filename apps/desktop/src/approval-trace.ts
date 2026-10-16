export type ApprovalTraceSummary = {
  toolName?: string;
  command?: string;
  title: string;
};

const titleLimit = 140;

function compactTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > titleLimit ? `${compact.slice(0, titleLimit - 1).trimEnd()}…` : compact;
}

function rootCommand(input: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const command = (parsed as Record<string, unknown>).command;
    return typeof command === "string" && command.trim() ? command : undefined;
  } catch {
    // The runtime truncates approval JSON after 2,000 characters. Only recover a
    // complete first root field; a `command` printed inside stdin is never input.
    const first = /^\s*\{\s*"command"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")\s*,/.exec(input);
    if (!first) return undefined;
    const command: unknown = JSON.parse(first[1]!);
    return typeof command === "string" && command.trim() ? command : undefined;
  }
}

/** Display-only projection. The original approval text remains the detail view. */
export function approvalTraceSummary(summary: string): ApprovalTraceSummary {
  const request = /^\s*([a-zA-Z_][\w.:/-]*)\s+\((read|write|high|destructive)\):\s*([\s\S]*)$/.exec(summary);
  if (!request) return { title: compactTitle(summary) || "工具调用" };
  const toolName = request[1]!;
  const command = rootCommand(request[3]!);
  return command === undefined
    ? { toolName, title: compactTitle(toolName) }
    : { toolName, command, title: compactTitle(`${toolName} · ${command}`) };
}
