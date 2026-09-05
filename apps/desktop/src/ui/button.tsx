import React from "react";

const VARIANTS = {
  primary: "bg-accent text-white hover:bg-blue-500 active:bg-blue-600",
  secondary: "bg-white/5 border border-line text-text hover:bg-white/10",
  ghost: "text-text-muted hover:text-text hover:bg-white/5",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
} as const;

export function BuiButton({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm"} ${VARIANTS[variant]} ${className}`.trim()}
    />
  );
}
