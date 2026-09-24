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
  let pendingTurnStart = false;
  let latestTurnStart: number | undefined;
  let activeGroup: Extract<TimelineItem, { kind: "tool_group" }> | undefined;
  const pushText = (value: string, process: boolean): boolean => {
    if (!value.trim() || isHiddenSystemMessage(value)) return false;
    stream.push({ kind: "text", id: `text-${textIndex++}`, text: value, process });
    return true;
  };
  const flushText = (process: boolean): boolean => {
    const emitted = pushText(text, process);
    text = "";
    pendingTurnStart = false;
    latestTurnStart = undefined;
    return emitted;
  };
  for (const event of events) {
    if (event.type === "text_delta") {
      if (pendingTurnStart && event.delta.trim()) {
        if (text && !/\s$/.test(text) && !/^\s/.test(event.delta)) text += " ";
        latestTurnStart = text.length;
        pendingTurnStart = false;
      }
      text += event.delta;
    } else if (event.type === "assistant_turn_started") {
      // Keep progress from adjacent model turns in one live message until an activity boundary.
      if (text.trim()) pendingTurnStart = true;
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
      let streamedText = text;
      const latestTurnText = latestTurnStart === undefined ? "" : text.slice(latestTurnStart).trimStart();
      if (paused && latestTurnStart !== undefined && isHiddenSystemMessage(latestTurnText)) {
        pushText(text.slice(0, latestTurnStart).trimEnd(), true);
        streamedText = latestTurnText;
        text = "";
        pendingTurnStart = false;
        latestTurnStart = undefined;
      } else if (!paused && latestTurnStart !== undefined) {
        pushText(text.slice(0, latestTurnStart).trimEnd(), true);
        streamedText = latestTurnText;
        pushText(streamedText, false);
        text = "";
        pendingTurnStart = false;
        latestTurnStart = undefined;
      } else if (!paused && pendingTurnStart) {
        pushText(text.trimEnd(), true);
        streamedText = "";
        text = "";
        pendingTurnStart = false;
        latestTurnStart = undefined;
      } else {
        flushText(paused);
      }
      const finalText = dedupeFinalText(streamedText, event.text);
      if (finalText && !isHiddenSystemMessage(finalText)) stream.push({ kind: "text", id: `result-${event.id}`, text: finalText, process: paused });
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
  flushText(!finalTextEvent(events));
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
