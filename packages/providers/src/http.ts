export async function* parseSse(response: Response, signal: AbortSignal): AsyncIterable<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Provider HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  }
  if (!response.body) throw new Error("Provider response had no body");

  const reader = response.body.getReader();
  const onAbort = () => void reader.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw signal.reason ?? new Error("Request aborted");
      }
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) {
        const trailing = buffer.trim();
        if (trailing) {
          const event = parseSseFrame(trailing);
          if (event) yield event;
        }
        break;
      }
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const event = parseSseFrame(chunk);
        if (event) yield event;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function parseSseFrame(chunk: string): unknown | undefined {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    // Ignore provider keep-alive or malformed diagnostic frames.
    return undefined;
  }
}

export function authHeaders(apiKey: string, extra: Record<string, string> = {}): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...extra };
}

export function roughTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

