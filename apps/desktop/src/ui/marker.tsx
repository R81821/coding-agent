/**
 * Adapted from shadcn/ui Base UI Marker.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/marker.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 * Tailwind utilities are translated to desktop theme tokens in marker.css.
 */
import type React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import "./marker.css";

type MarkerVariant = "default" | "separator" | "border";
type MarkerProps = useRender.ComponentProps<"div"> & { variant?: MarkerVariant };

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function markerVariants({ variant = "default", className }: { variant?: MarkerVariant | undefined; className?: string | undefined } = {}) {
  return classes("ui-marker", `ui-marker-variant-${variant}`, className);
}

function Marker({ className, variant = "default", render, ...props }: MarkerProps) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: markerVariants({ variant, className }) }, props),
    render,
    state: { slot: "marker", variant },
  });
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="marker-icon" aria-hidden="true" className={classes("ui-marker-icon", className)} {...props} />;
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="marker-content" className={classes("ui-marker-content", className)} {...props} />;
}

export { Marker, MarkerIcon, MarkerContent, markerVariants };
export type { MarkerProps, MarkerVariant };
