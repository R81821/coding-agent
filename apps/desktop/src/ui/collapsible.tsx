/**
 * Adapted from shadcn/ui Base UI Collapsible.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/collapsible.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 */
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

type CollapsibleProps = Omit<CollapsiblePrimitive.Root.Props, "className"> & { className?: string };
type CollapsibleTriggerProps = Omit<CollapsiblePrimitive.Trigger.Props, "className"> & { className?: string };
type CollapsibleContentProps = Omit<CollapsiblePrimitive.Panel.Props, "className"> & { className?: string };

function Collapsible(props: CollapsibleProps) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(props: CollapsibleTriggerProps) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ keepMounted = false, ...props }: CollapsibleContentProps) {
  // Base UI owns the panel lifecycle: closed detail is not mounted by default.
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" keepMounted={keepMounted} {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
export type { CollapsibleProps, CollapsibleTriggerProps, CollapsibleContentProps };
