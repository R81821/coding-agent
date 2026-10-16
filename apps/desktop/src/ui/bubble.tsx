/**
 * Adapted from shadcn/ui Base UI Bubble.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/bubble.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 */
import React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");
type BubbleVariant = "default" | "secondary" | "muted" | "tinted" | "outline" | "ghost" | "destructive";

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="bubble-group" className={classes("ui-bubble-group", className)} {...props} />;
}

function Bubble({
  className,
  align = "start",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end"; variant?: BubbleVariant }) {
  return <div data-slot="bubble" data-align={align} data-variant={variant} className={classes("ui-bubble", className)} {...props} />;
}

function BubbleContent({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: classes("ui-bubble-content", className) }, props),
    render,
    state: { slot: "bubble-content" },
  });
}

function BubbleReactions({
  className,
  align = "end",
  side = "bottom",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end"; side?: "top" | "bottom" }) {
  return <div data-slot="bubble-reactions" data-align={align} data-side={side} className={classes("ui-bubble-reactions", className)} {...props} />;
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions };
export type { BubbleVariant };
