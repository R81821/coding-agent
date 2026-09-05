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
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] ${
        status === "running"
          ? "border-accent/40 bg-accent-soft text-accent-text animate-pulse"
          : status === "failed"
            ? "border-danger/40 bg-danger/12 text-danger"
            : "border-line bg-white/5 text-text-muted"
      }`}
    >
      <Wrench size={12} aria-hidden="true" />
      {name}
    </span>
  );
}
