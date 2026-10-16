/**
 * Adapted from shadcn/ui Base UI Hover Card.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/hover-card.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 * Tailwind utilities are translated to desktop theme tokens in hover-card.css.
 */
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import "./hover-card.css";

type HoverCardProps = PreviewCardPrimitive.Root.Props;
type HoverCardTriggerProps = PreviewCardPrimitive.Trigger.Props;
type HoverCardContentProps = PreviewCardPrimitive.Popup.Props & Pick<
  PreviewCardPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "side"
  | "sideOffset"
  | "collisionBoundary"
  | "collisionPadding"
  | "collisionAvoidance"
  | "positionMethod"
>;

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function HoverCard(props: HoverCardProps) {
  return <PreviewCardPrimitive.Root {...props} />;
}

function HoverCardTrigger({ render, ...props }: HoverCardTriggerProps) {
  // When composed with a Collapsible trigger, keep that button's data-slot,
  // expansion semantics, click handlers, and ref on the same DOM element.
  return (
    <PreviewCardPrimitive.Trigger
      {...(!render ? { "data-slot": "hover-card-trigger" } : {})}
      data-hover-card-trigger=""
      render={render}
      {...props}
    />
  );
}

function HoverCardContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 4,
  collisionBoundary,
  collisionPadding = 12,
  collisionAvoidance,
  positionMethod = "fixed",
  ...props
}: HoverCardContentProps) {
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
      <PreviewCardPrimitive.Positioner
        data-slot="hover-card-positioner"
        className="ui-hover-card-positioner"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        positionMethod={positionMethod}
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={(state) => classes("ui-hover-card-content", typeof className === "function" ? className(state) : className)}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
export type { HoverCardProps, HoverCardTriggerProps, HoverCardContentProps };
