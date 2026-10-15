export interface McpContent { type?: string; text?: string; uri?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string; blob?: string }; data?: string }
export interface McpPromptResult { description?: string; messages: Array<{ role: string; content: McpContent }> }
export interface McpResourceResult { contents: Array<{ uri: string; text?: string; mimeType?: string; blob?: string }> }

export function mcpContentText(content: McpContent): string {
  if (typeof content.text === "string") return content.text;
  if (content.resource) return content.resource.text ?? `[资源 ${content.resource.uri ?? ""} · ${content.resource.mimeType ?? "二进制内容"}]`;
  if (content.type === "resource_link") return `[资源链接 ${content.uri ?? ""}]`;
  return `[${content.type === "image" ? "图片" : content.type === "audio" ? "音频" : "内容"} · ${content.mimeType ?? "暂无文本预览"}]`;
}

// Roles remain visible quoted content; applying a prompt never creates system messages.
export function mcpPromptDraft(result: McpPromptResult, serverName: string, name: string): string {
  const messages = result.messages.map(message => `[${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role}]\n${mcpContentText(message.content)}`).join("\n\n");
  return `来自 MCP 提示词：${serverName} / ${name}\n\n${messages}`;
}

export function mcpResourceDraft(result: McpResourceResult, serverName: string): string {
  return result.contents.filter(content => typeof content.text === "string").map(content => `来自 MCP 资源：${serverName}\nURI：${content.uri}\n\n${content.text}`).join("\n\n");
}

// MCP completion supplies scalar strings. Preserve RFC 6570 operators when
// expanding those strings; manually entered URIs remain available for lists/maps.
export function mcpTemplateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([+#./;?&]?)([^{}]+)\}/g)].flatMap(match => match[2]!.split(",").map(variable => variable.replace(/\*$/, "").replace(/:\d+$/, ""))))];
}

export function mcpTemplateUri(template: string, values: Record<string, string>): string {
  const encode = (value: string, reserved: boolean) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%[0-9A-F]{2}/g, escaped => reserved && ":/?#[]@!$&'()*+,;=".includes(String.fromCharCode(parseInt(escaped.slice(1), 16))) ? String.fromCharCode(parseInt(escaped.slice(1), 16)) : escaped);
  return template.replace(/\{([+#./;?&]?)([^{}]+)\}/g, (expression: string, operator: string, variables: string) => {
    const entries = variables.split(",").map(variable => {
      const name = variable.replace(/\*$/, "").replace(/:\d+$/, "");
      const prefix = /:(\d+)$/.exec(variable)?.[1];
      const value = values[name];
      if (value === undefined || value === "") return undefined;
      const encoded = encode(prefix ? [...value].slice(0, Number(prefix)).join("") : value, operator === "+" || operator === "#");
      return [";", "?", "&"].includes(operator) ? `${name}=${encoded}` : encoded;
    });
    if (entries.some(value => value === undefined)) return expression;
    const separator = operator === "." || operator === "/" || operator === ";" ? operator : operator === "?" || operator === "&" ? "&" : ",";
    return `${operator && operator !== "+" ? operator : ""}${entries.join(separator)}`;
  });
}
