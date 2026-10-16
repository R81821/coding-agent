import { useEffect, useState } from "react";
import type { AgentEvent } from "@harness/protocol";

/** Replay recorded boundaries, never replay tool calls or mutate the stored conversation. */
export function conversationReplayFrames(events: AgentEvent[]): number[] {
  const boundaries = events.flatMap((event, index) =>
    ["reasoning_summary", "tool_started", "tool_finished", "steering_submitted", "result"].includes(event.type)
      ? [index + 1] : []);
  if (boundaries.at(-1) !== events.length) boundaries.push(events.length);
  const frames = boundaries.length <= 32 ? boundaries : boundaries.filter((_, index) =>
    index === 0 || Math.floor(index * 31 / (boundaries.length - 1)) !== Math.floor((index - 1) * 31 / (boundaries.length - 1)));
  return [0, ...frames.filter(value => value > 0)];
}

export function useConversationReplay(events: AgentEvent[], enabled: boolean) {
  const [replay, setReplay] = useState<{ source: AgentEvent[]; frames: number[]; frame: number }>();
  const replaying = enabled && replay !== undefined && replay.source === events;
  useEffect(() => {
    if (!replay) return;
    if (!enabled || replay.source !== events) { setReplay(undefined); return; }
    const timer = setTimeout(() => setReplay(current => {
      if (!current || current !== replay) return current;
      return current.frame + 1 < current.frames.length ? { ...current, frame: current.frame + 1 } : undefined;
    }), replay.frame === replay.frames.length - 1 ? 700 : 280);
    return () => clearTimeout(timer);
  }, [replay, enabled, events]);
  return {
    events: replaying ? events.slice(0, replay.frames[replay.frame]) : events,
    replaying,
    start: () => { if (enabled) setReplay({ source: events, frames: conversationReplayFrames(events), frame: 0 }); },
    stop: () => setReplay(undefined),
  };
}
