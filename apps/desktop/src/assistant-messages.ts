import type { AgentEvent } from "@harness/protocol";

export function dedupeFinalText(streamText: string, resultText: string): string {
  const stream = streamText.trim();
  const result = resultText.trim();
  if (!result) return "";
  if (!stream) return resultText;
  if (stream === result || stream.includes(result) || result.includes(stream)) return "";
  return resultText;
}

export function assistantMessages(events: AgentEvent[]): { text: string; progress: string[] } {
  let text = "";
  const progress: string[] = [];
  for (const event of events) {
    if (event.type === "assistant_turn_started") {
      if (text.trim()) progress.push(text);
      text = "";
    } else if (event.type === "text_delta") {
      text += event.delta;
    } else if (event.type === "result") {
      if (text.trim() && text.trim() !== event.text.trim()) progress.push(text);
      text = event.text;
    }
  }
  return { text, progress };
}
