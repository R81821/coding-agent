/**
 * Adapted from shadcn/ui Base UI Attachment.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/attachment.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 * Tailwind utilities are translated to desktop theme tokens in attachment.css.
 */
import type React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import "./attachment.css";

type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";
type AttachmentSize = "default" | "sm" | "xs";
type AttachmentOrientation = "horizontal" | "vertical";
type AttachmentProps = React.ComponentProps<"div"> & {
  state?: AttachmentState;
  size?: AttachmentSize;
  orientation?: AttachmentOrientation;
};
type AttachmentMediaProps = React.ComponentProps<"div"> & { variant?: "icon" | "image" };
type AttachmentActionProps = React.ComponentProps<"button"> & {
  variant?: "default" | "secondary" | "ghost" | "outline" | "destructive" | "link";
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
};
type AttachmentTriggerProps = useRender.ComponentProps<"button">;

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function Attachment({ className, state = "done", size = "default", orientation = "horizontal", ...props }: AttachmentProps) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={classes("ui-attachment", className)}
      {...props}
    />
  );
}

function AttachmentMedia({ className, variant = "icon", ...props }: AttachmentMediaProps) {
  return <div data-slot="attachment-media" data-variant={variant} className={classes("ui-attachment-media", className)} {...props} />;
}

function AttachmentContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-content" className={classes("ui-attachment-content", className)} {...props} />;
}

function AttachmentTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="attachment-title" className={classes("ui-attachment-title", className)} {...props} />;
}

function AttachmentDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="attachment-description" className={classes("ui-attachment-description", className)} {...props} />;
}

function AttachmentActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-actions" className={classes("ui-attachment-actions", className)} {...props} />;
}

function AttachmentAction({ className, variant = "ghost", size = "icon-xs", type = "button", ...props }: AttachmentActionProps) {
  return (
    <button
      type={type}
      data-slot="attachment-action"
      data-variant={variant}
      data-size={size}
      className={classes("ui-attachment-action", className)}
      {...props}
    />
  );
}

function AttachmentTrigger({ className, render, type, ...props }: AttachmentTriggerProps) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type: render ? type : (type ?? "button"),
        className: classes("ui-attachment-trigger", className),
      },
      props,
    ),
    render,
    state: { slot: "attachment-trigger" },
  });
}

function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="attachment-group" className={classes("ui-attachment-group", className)} {...props} />;
}

export {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
};
export type {
  AttachmentState,
  AttachmentSize,
  AttachmentOrientation,
  AttachmentProps,
  AttachmentMediaProps,
  AttachmentActionProps,
  AttachmentTriggerProps,
};
