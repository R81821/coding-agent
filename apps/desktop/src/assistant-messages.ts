import type { AgentEvent } from "@harness/protocol";

export function dedupeFinalText(streamText: string, resultText: string): string {
  const stream = streamText.trim();
  const result = resultText.trim();
  if (!result) return "";
  if (!stream) return resultText;
  if (stream === result) return "";
  return resultText;
}

/** Old results have no turn reference. Only exact text or an appended paragraph is safe to replace. */
export function replacesFinalText(streamText: string, resultText: string): boolean {
  const stream = streamText.trim();
  const result = resultText.trim();
  return Boolean(stream) && (stream === result ||
    (result.startsWith(stream) && /^[ \t]*\r?\n/.test(result.slice(stream.length))));
}

export function assistantMessages(events: AgentEvent[]): { text: string; progress: string[] } {
  let text = "";
  let turn: string | undefined;
  const progress: { text: string; turn: string | undefined }[] = [];
  const rememberText = () => { if (text.trim()) progress.push({ text, turn }); };
  for (const event of events) {
    if (event.type === "assistant_turn_started") {
      rememberText();
      text = "";
      turn = `${event.runId}\0${event.sequence}`;
    } else if (event.type === "text_delta") {
      if (!turn?.startsWith(`${event.runId}\0`)) turn = `${event.runId}\0unmarked`;
      text += event.delta;
    } else if (event.type === "result") {
      if (event.status !== "paused" && event.sourceAssistantTurnSequence !== undefined) {
        const source = `${event.runId}\0${event.sourceAssistantTurnSequence}`;
        const fallback = !progress.some(item => item.turn === source) && turn === `${event.runId}\0unmarked` &&
          replacesFinalText(text, event.text) ? turn : undefined;
        rememberText();
        turn = source;
        for (let index = progress.length - 1; index >= 0; index--) {
          if (progress[index]?.turn === turn || (fallback !== undefined && progress[index]?.turn === fallback)) progress.splice(index, 1);
        }
      } else if (!replacesFinalText(text, event.text)) {
        rememberText();
      }
      text = event.text;
    }
  }
  return { text, progress: progress.map(item => item.text) };
}
