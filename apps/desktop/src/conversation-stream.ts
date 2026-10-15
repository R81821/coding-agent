import type { AgentEvent } from "@harness/protocol";
import { dedupeFinalText, replacesFinalText } from "./assistant-messages.js";

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;
type ResultEvent = Extract<AgentEvent, { type: "result" }>;
type TextPart = { text: string; turn: string | undefined };

export type ToolTimelineItem = {
  kind: "tool";
  started: ToolStartedEvent;
  finished?: ToolFinishedEvent;
};

export type TimelineItem =
  | { kind: "tool_group"; id: string; tools: ToolTimelineItem[] }
  | { kind: "event"; event: AgentEvent };

export type ConversationStreamItem =
  | { kind: "text"; id: string; text: string; process: boolean; result?: ResultEvent }
  | { kind: "user_message"; id: string; text: string; sequence: number }
  | Extract<TimelineItem, { kind: "tool_group" }>
  | Extract<TimelineItem, { kind: "event" }>;

export function buildConversationStream(events: AgentEvent[]): ConversationStreamItem[] {
  const stream: ConversationStreamItem[] = [];
  const tools = new Map<string, ToolTimelineItem>();
  let text = "";
  let textIndex = 0;
  let pendingTurnStart = false;
  let latestTurnStart: number | undefined;
  let currentTurn: string | undefined;
  let textParts: TextPart[] = [];
  const emittedParts = new Map<ConversationStreamItem, TextPart[]>();
  const submittedMessages = new Set(events.flatMap(event => event.type === "steering_submitted" ? [`${event.runId}\0${event.messageId}`] : []));
  const userMessages = new Set<string>();
  let segmentStart = 0;
  let lastUserEventIndex = -1;
  let activeGroup: Extract<TimelineItem, { kind: "tool_group" }> | undefined;
  const pushText = (value: string, process: boolean, parts: TextPart[] = [], result?: ResultEvent): boolean => {
    if (!value.trim() || isHiddenSystemMessage(value)) return false;
    const item: ConversationStreamItem = { kind: "text", id: `text-${textIndex++}`, text: value, process, ...(result ? { result } : {}) };
    stream.push(item);
    emittedParts.set(item, parts);
    return true;
  };
  const resetText = () => {
    text = "";
    textParts = [];
    pendingTurnStart = false;
    latestTurnStart = undefined;
  };
  const flushText = (process: boolean): boolean => {
    const emitted = pushText(text, process, textParts);
    resetText();
    return emitted;
  };
  const removeTurnText = (turn: string) => {
    // A report may already have been flushed by an activity event. Remove only its exact
    // source turn, leaving every other turn and the stored events intact.
    for (let index = stream.length - 1; index >= segmentStart; index--) {
      const item = stream[index];
      if (item?.kind !== "text") continue;
      const parts = emittedParts.get(item);
      if (!parts?.some(part => part.turn === turn)) continue;
      const remaining = parts.filter(part => part.turn !== turn);
      const value = remaining.map(part => part.text).join("").trim();
      if (value) {
        item.text = value;
        item.process = true;
        delete item.result;
        emittedParts.set(item, remaining);
      } else {
        stream.splice(index, 1);
        emittedParts.delete(item);
      }
    }
  };
  const turnText = (turn: string | undefined): string => turn === undefined ? "" :
    [...stream.slice(segmentStart).map(item => emittedParts.get(item) ?? []), textParts].flatMap(parts => parts.filter(part => part.turn === turn)).map(part => part.text).join("");
  for (const [eventIndex, event] of events.entries()) {
    if (event.type === "steering_submitted" || event.type === "steering_delivered") {
      const messageId = event.messageId ?? event.id;
      const key = `${event.runId}\0${messageId}`;
      // Delivery confirms model receipt. The earlier submission owns the visible bubble.
      if (event.type === "steering_delivered" && event.messageId && submittedMessages.has(key)) continue;
      if (userMessages.has(key)) continue;
      userMessages.add(key);
      flushText(true);
      activeGroup = undefined;
      currentTurn = undefined;
      stream.push({ kind: "user_message", id: `user-message-${event.runId}-${messageId}`, text: event.text, sequence: event.sequence });
      // A later authoritative report must never replace assistant text across a human reply.
      segmentStart = stream.length;
      lastUserEventIndex = eventIndex;
    } else if (event.type === "text_delta") {
      if (pendingTurnStart && event.delta.trim()) {
        if (text && !/\s$/.test(text) && !/^\s/.test(event.delta)) {
          text += " ";
          textParts.push({ text: " ", turn: undefined });
        }
        latestTurnStart = text.length;
        pendingTurnStart = false;
      }
      text += event.delta;
      if (!currentTurn?.startsWith(`${event.runId}\0`)) currentTurn = `${event.runId}\0unmarked`;
      const turn = currentTurn;
      const last = textParts.at(-1);
      if (last && last.turn === turn) last.text += event.delta;
      else textParts.push({ text: event.delta, turn });
    } else if (event.type === "assistant_turn_started") {
      // Keep progress from adjacent model turns in one live message until an activity boundary.
      if (text.trim()) pendingTurnStart = true;
      currentTurn = `${event.runId}\0${event.sequence}`;
    } else if (event.type === "tool_started") {
      if (flushText(true)) activeGroup = undefined;
      const item: ToolTimelineItem = { kind: "tool", started: event };
      tools.set(event.call.id, item);
      if (!activeGroup) {
        activeGroup = { kind: "tool_group", id: `tool-group-${event.id}`, tools: [] };
        stream.push(activeGroup);
      }
      activeGroup.tools.push(item);
    } else if (event.type === "tool_finished") {
      const tool = tools.get(event.callId);
      if (tool) tool.finished = event;
    } else if (event.type === "result") {
      const paused = event.status === "paused";
      if (!paused && event.sourceAssistantTurnSequence !== undefined) {
        const turn = `${event.runId}\0${event.sourceAssistantTurnSequence}`;
        // A preview/page may contain text but omit its turn marker. Use only the same
        // exact-prefix compatibility rule until canonical events provide the reference.
        const fallback = !turnText(turn) && currentTurn === `${event.runId}\0unmarked` &&
          replacesFinalText(turnText(currentTurn), event.text) ? currentTurn : undefined;
        flushText(true);
        removeTurnText(turn);
        if (fallback) removeTurnText(fallback);
        pushText(event.text, false, [{ text: event.text, turn }], event);
      } else if (!paused && currentTurn?.startsWith(`${event.runId}\0`) && replacesFinalText(turnText(currentTurn), event.text)) {
        flushText(true);
        removeTurnText(currentTurn);
        pushText(event.text, false, [{ text: event.text, turn: currentTurn }], event);
      } else {
        const start = pendingTurnStart ? text.length : latestTurnStart ?? 0;
        const prefix = text.slice(0, start).trimEnd();
        const streamedText = text.slice(start).trimStart();
        pushText(prefix, true);
        if (!paused && replacesFinalText(streamedText, event.text)) {
          // Preserve an added stop/review paragraph instead of discarding the whole result.
          pushText(event.text, false, [], event);
        } else {
          pushText(streamedText, paused || Boolean(event.text.trim()), [],
            !paused && !event.text.trim() ? event : undefined);
          const finalText = dedupeFinalText(streamedText, event.text);
          if (finalText) pushText(finalText, paused, [], event);
        }
        resetText();
      }
      activeGroup = undefined;
    } else if (event.type === "approval_required" || event.type === "error" || event.type === "provider_retry" || event.type === "self_correction_started" || event.type === "repair_started" || event.type === "capabilities_resolved") {
      flushText(true);
      // Self-correction and repair markers describe the same active tool phase. They should
      // remain visible in the stream without fragmenting consecutive tools into one-item groups.
      if (event.type !== "self_correction_started" && event.type !== "repair_started") {
        activeGroup = undefined;
        stream.push({ kind: "event", event });
      }
    }
  }
  flushText(!finalTextEvent(events.slice(lastUserEventIndex + 1)));
  return stream;
}

function isHiddenSystemMessage(text: string): boolean {
  return /^运行已暂停[。．]?\s*可以继续，或补充说明后再继续。?$/.test(text.trim());
}

function finalTextEvent(events: AgentEvent[]): boolean {
  const result = events.findLast((event) => event.type === "result");
  return result?.type === "result" && result.status !== "paused" && Boolean(result.text.trim()) && !isHiddenSystemMessage(result.text);
}

type CapabilitiesEvent = Extract<AgentEvent, { type: "capabilities_resolved" }>;

export function capabilitiesSummary(event: CapabilitiesEvent): { label: string; detail: string; warning: boolean } | undefined {
  // Emitted on every run; stay silent when there is nothing to report.
  if (!event.mcp.length && !event.diagnostics.length && !event.skills.length) return undefined;
  const warning = event.diagnostics.length > 0;
  return {
    label: `MCP ${event.mcp.length} 个工具 · 技能 ${event.skills.length} 个`,
    detail: warning
      ? `${event.diagnostics.length} 个服务不可用：${event.diagnostics.map(item => item.name).join("、")}`
      : `${new Set(event.mcp.map(tool => tool.serverId)).size} 个服务可用`,
    warning,
  };
}
