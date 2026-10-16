import React from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import "./conversation-hover-card.css";

type ConversationHoverCardProps = {
  kind: "read" | "operation" | "tool" | "approval" | "source";
  label: string;
  trigger: React.ReactElement;
  children: () => React.ReactNode;
};

// The portal mounts this component only when shown. Previewing a collapsed row
// never constructs its full file list or serializes its input/output.
function Preview({ label, children }: Pick<ConversationHoverCardProps, "label" | "children">) {
  return <div className="conversation-hover-preview">
    <strong className="conversation-hover-heading">{label}</strong>
    {children()}
  </div>;
}

export function ConversationHoverCard({ kind, label, trigger, children }: ConversationHoverCardProps) {
  return <HoverCard>
    <HoverCardTrigger render={trigger} delay={1000} closeDelay={200} data-conversation-hover={kind} />
    <HoverCardContent align="start" alignOffset={0} sideOffset={6} data-conversation-hover-content={kind}>
      <Preview label={label}>{children}</Preview>
    </HoverCardContent>
  </HoverCard>;
}
