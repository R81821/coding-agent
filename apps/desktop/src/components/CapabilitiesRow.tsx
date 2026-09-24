import React from "react";
import { Plug } from "lucide-react";
import type { AgentEvent } from "@harness/protocol";
import { capabilitiesSummary } from "../conversation-stream.js";

type CapabilitiesEvent = Extract<AgentEvent, { type: "capabilities_resolved" }>;

export function CapabilitiesRow({ event }: { event: CapabilitiesEvent }) {
  const summary = capabilitiesSummary(event);
  if (!summary) return null;
  return (
    <div className={`activity-row${summary.warning ? " activity-row-warning" : ""}`}>
      <Plug size={15} aria-hidden="true" />
      <strong>{summary.label}</strong>
      <small>{summary.detail}</small>
    </div>
  );
}
