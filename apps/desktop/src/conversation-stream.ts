import type { AgentEvent } from "@harness/protocol";
import { dedupeFinalText } from "./assistant-messages.js";

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;

export type ToolTimelineItem = {
  kind: "tool";
  started: ToolStartedEvent;
  finished?: ToolFinishedEvent;
};

export type TimelineItem =
  | { kind: "tool_group"; id: string; tools: ToolTimelineItem[] }
  | { kind: "event"; event: AgentEvent };

export type ConversationStreamItem =
  | { kind: "text"; id: string; text: string; process: boolean }
  | Extract<TimelineItem, { kind: "tool_group" }>
  | Extract<TimelineItem, { kind: "event" }>;

export function buildConversationStream(events: AgentEvent[]): ConversationStreamItem[] {
  const stream: ConversationStreamItem[] = [];
  const tools = new Map<string, ToolTimelineItem>();
  let text = "";
  let textIndex = 0;
  let activeGroup: Extract<TimelineItem, { kind: "tool_group" }> | undefined;
  const flushText = (process: boolean) => {
    if (!text.trim()) return;
    stream.push({ kind: "text", id: `text-${textIndex++}`, text, process });
    text = "";
  };
  for (const event of events) {
    if (event.type === "text_delta") {
      text += event.delta;
    } else if (event.type === "assistant_turn_started") {
      flushText(true);
      // A model turn boundary does not necessarily produce visible text. Keep consecutive
      // tool calls in one activity group until a real message or status event separates them.
    } else if (event.type === "tool_started") {
      flushText(true);
      const item: ToolTimelineItem = { kind: "tool", started: event };
      tools.set(event.call.id, item);
      if (!activeGroup) {
        activeGroup = { kind: "tool_group", id: `tool-group-${event.id}`, tools: [] };
        stream.push(activeGroup);
      }
      activeGroup.tools.push(item);
    } else if (event.type === "tool_finished") {
      tools.get(event.callId)!.finished = event;
    } else if (event.type === "result") {
      flushText(false);
      const lastText = stream.at(-1);
      const streamedText = lastText?.kind === "text" ? lastText.text : "";
      const finalText = dedupeFinalText(streamedText, event.text);
      if (finalText && !isHiddenSystemMessage(finalText)) stream.push({ kind: "text", id: `result-${event.id}`, text: finalText, process: false });
      activeGroup = undefined;
    } else if (event.type === "approval_required" || event.type === "error" || event.type === "provider_retry" || event.type === "self_correction_started" || event.type === "repair_started") {
      flushText(true);
      // Self-correction and repair markers describe the same active tool phase. They should
      // remain visible in the stream without fragmenting consecutive tools into one-item groups.
      if (event.type !== "self_correction_started" && event.type !== "repair_started") {
        activeGroup = undefined;
        stream.push({ kind: "event", event });
      }
    }
  }
  flushText(!finalTextEvent(events));
  return stream;
}

function isHiddenSystemMessage(text: string): boolean {
  return /^运行已暂停[。．]?\s*可以继续，或补充说明后再继续。?$/.test(text.trim());
}

function finalTextEvent(events: AgentEvent[]): boolean {
  return events.some((event) => event.type === "result" && Boolean(event.text.trim()));
}
