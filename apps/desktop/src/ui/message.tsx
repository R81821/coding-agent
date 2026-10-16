/**
 * Adapted from shadcn/ui Base UI Message.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/message.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 */
import React from "react";

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-group" className={classes("ui-message-group", className)} {...props} />;
}

function Message({ className, align = "start", ...props }: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return <div data-slot="message" data-align={align} className={classes("ui-message", className)} {...props} />;
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-avatar" className={classes("ui-message-avatar", className)} {...props} />;
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-content" className={classes("ui-message-content", className)} {...props} />;
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-header" className={classes("ui-message-header", className)} {...props} />;
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-footer" className={classes("ui-message-footer", className)} {...props} />;
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageHeader, MessageFooter };
