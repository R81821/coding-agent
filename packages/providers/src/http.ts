const SSE_DONE = Symbol("sse_done");

export async function* parseSse(response: Response, signal: AbortSignal): AsyncIterable<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Provider HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  }
  if (!response.body) throw new Error("Provider response had no body");

  const reader = response.body.getReader();
  let ended = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled || ended) return;
    cancelled = true;
    // Cleanup failures must not replace cancellation or become unhandled rejections.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      // cancel() resolves a pending read with done=true; it is not a successful EOF.
      signal.throwIfAborted();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) {
        ended = true;
        buffer += decoder.decode();
        const event = parseSseFrame(buffer.trim());
        if (event && event !== SSE_DONE) yield event;
        return;
      }
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        signal.throwIfAborted();
        const event = parseSseFrame(chunk);
        if (event === SSE_DONE) return;
        if (event) yield event;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function parseSseFrame(chunk: string): unknown | undefined {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "[DONE]") return SSE_DONE;
  if (!data) return undefined;
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

