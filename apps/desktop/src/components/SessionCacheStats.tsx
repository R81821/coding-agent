import React, { useMemo } from "react";
import { isCommittedContextAdjustment, latestContextUsage, type AgentEvent } from "@harness/protocol";
import type { SessionTurn } from "../run-history.js";
import { PromptCacheStats } from "./PromptCacheStats.js";

const noWithdrawnEvents: readonly AgentEvent[] = [];

/** A new round's preparation is not a replacement for the conversation's last measured context. */
function conversationContextUsage(turns: readonly SessionTurn[]) {
  let previous: ReturnType<typeof latestContextUsage>;
  const update = (events: readonly AgentEvent[]) => {
    const context = latestContextUsage(events, { preserveMeasurements: true });
    if (!context) return;
    const hasMainResponse = events.some(event => event.type === "model_request_finished" && event.purpose === "main" && event.succeeded);
    const hasMainMeasurement = events.some(event => event.type === "context_usage" && event.context.source === "provider" && event.context.usedTokens > 0
      || event.type === "usage" && (event.usage.purpose === undefined || event.usage.purpose === "main") && event.usage.inputTokens > 0);
    const hasContextChange = events.some(event => event.type === "context_compacted"
      || event.type === "context_adjusted" && isCommittedContextAdjustment(event.adjustment));
    // Finishing a request does not calibrate an estimate if the provider omitted input usage.
    // This remains true after pausing/completing and on further requests in the same round.
    // Estimate-only providers may report growth after responding, but an uncalibrated drop
    // cannot erase the preceding conversation measurement without a committed history change.
    const uncalibrated = !hasMainMeasurement && (!hasMainResponse || previous !== undefined && context.usedTokens < previous.usedTokens);
    if (previous && uncalibrated && context.source === "estimate"
      && previous.capacityTokens === context.capacityTokens && !hasContextChange) return;
    previous = context;
  };
  for (const turn of turns) {
    if (turn.parentRunId !== undefined) continue;
    let start = 0;
    let route: Extract<AgentEvent, { type: "route" }> | undefined;
    for (let index = 0; index < turn.events.length; index++) {
      const event = turn.events[index]!;
      if (event.type !== "route") continue;
      if (route && (route.providerId !== event.providerId || route.modelId !== event.modelId)) {
        update(turn.events.slice(start, index));
        start = index;
      }
      route = event;
    }
    update(turn.events.slice(start));
  }
  return previous;
}

export function SessionCacheStats({ turns, hasOlder = false, withdrawnEvents = noWithdrawnEvents }: { turns: readonly SessionTurn[]; hasOlder?: boolean; withdrawnEvents?: readonly AgentEvent[] }) {
  const events = useMemo(() => [...turns.flatMap(turn => turn.events), ...withdrawnEvents], [turns, withdrawnEvents]);
  const usages = useMemo(() => events.flatMap(event => event.type === "usage" ? [event.usage] : []), [events]);
  const contextUsage = useMemo(() => conversationContextUsage(turns), [turns]);
  const eventsComplete = !hasOlder && turns.every(turn => turn.view?.eventsComplete !== false);
  return <PromptCacheStats usages={usages} events={events} contextUsage={contextUsage ?? null} eventsComplete={eventsComplete} />;
}
