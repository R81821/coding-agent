import React from "react";

export function BuiGlassPanel({
  strong = false,
  className = "",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return (
    <div {...props} className={`${strong ? "glass-strong" : "glass"} ${className}`.trim()}>
      {children}
    </div>
  );
}
