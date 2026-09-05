import React from "react";
import { BuiGlassPanel } from "./card.js";

export function BuiEmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <BuiGlassPanel className="flex flex-col items-center gap-3 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
        {icon}
      </div>
      <h2 className="text-base font-semibold text-text">{title}</h2>
      <p className="max-w-md text-sm text-text-muted">{description}</p>
      {children}
    </BuiGlassPanel>
  );
}
