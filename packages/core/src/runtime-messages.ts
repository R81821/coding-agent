import type { ModelMessage } from "@harness/protocol";

const STOP_PREFIX = "Runtime stopping condition: ";
const STOP_INSTRUCTIONS = "\nNo tools are available. Answer the original user request using only evidence already collected. State concrete findings and file paths, then unresolved questions and uninspected scope. Do not say you will keep exploring or claim the task is complete. Use the user's language.";

export function runtimeStopSummary(reason: string): string {
  return STOP_PREFIX + reason + STOP_INSTRUCTIONS;
}

/** Runtime control for one summary request is never an ongoing user requirement. */
export function stripRuntimeSummaryMessages(messages: ModelMessage[], protectedTexts: string[] = []): ModelMessage[] {
  return messages.filter(message => {
    if (message.role !== "user") return true;
    if (message.runtimePrompt === "stop_summary") return false;
    // Older checkpoints have no provenance. Recognize only the exact generated envelope,
    // never a quoted instruction, a substring, or a message containing attachments.
    const part = message.content.length === 1 ? message.content[0] : undefined;
    if (part?.type !== "text" || part.trust !== "user_request" || protectedTexts.includes(part.text)) return true;
    return !(part.text.startsWith(STOP_PREFIX) && part.text.endsWith(STOP_INSTRUCTIONS) &&
      part.text.length > STOP_PREFIX.length + STOP_INSTRUCTIONS.length);
  });
}
