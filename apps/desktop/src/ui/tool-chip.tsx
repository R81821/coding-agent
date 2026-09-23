import { Wrench } from "lucide-react";

export function BuiToolChip({
  name,
  status = "idle",
}: {
  name: string;
  status?: "running" | "finished" | "failed" | "idle";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[11px] ${
        status === "running"
          ? "text-accent-text animate-pulse"
          : status === "failed"
            ? "text-danger"
            : "text-text-muted"
      }`}
    >
      <Wrench size={12} aria-hidden="true" />
      {name}
    </span>
  );
}
