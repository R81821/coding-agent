/**
 * Adapted from shadcn/ui Base UI Trace.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/trace.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 * The original Tailwind styles are in conversation-trace.css for this app.
 */
import React from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="trace" className={classes("ui-trace", className)} {...props} />;
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  return <span data-slot="trace-line" data-status={status} className={classes("ui-trace-line", className)} {...props} />;
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-icon" className={classes("ui-trace-icon", className)} {...props} aria-hidden="true" />;
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-title" className={classes("ui-trace-title", className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-description" className={classes("ui-trace-description", className)} {...props} />;
}

function TraceCollapsible({ className, ...props }: React.ComponentProps<typeof Collapsible>) {
  return <Collapsible data-slot="trace-collapsible" className={classes("ui-trace-collapsible", className)} {...props} />;
}

function TraceCollapsibleTrigger({ className, children, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={classes("ui-trace-collapsible-trigger", className)}
      {...props}
    >
      {children}
      <TraceIcon className="ui-trace-chevron"><ChevronRight /></TraceIcon>
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" className="ui-trace-collapsible-content" {...props}>
      <div data-slot="trace-collapsible-content-inner" className={classes("ui-trace-collapsible-content-inner", className)}>
        {children}
      </div>
    </CollapsibleContent>
  );
}

export { Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent };
