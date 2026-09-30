import {
  Circle,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleX,
  Clock3,
  LoaderCircle,
} from "lucide-react";
import type { RunStatus } from "@harness/protocol";
import { statusLabels } from "../lib/model";
import { cn } from "../lib/utils";

export function StatusMarker({
  status,
  className,
}: {
  status?: RunStatus | undefined;
  className?: string;
}) {
  const Icon =
    status === "completed"
      ? CircleCheck
      : status === "failed"
        ? CircleX
        : status === "paused"
          ? CirclePause
          : status === "cancelled"
            ? CircleMinus
            : status === "waiting_approval"
              ? CircleHelp
              : status === "queued"
                ? Clock3
                : status
                  ? LoaderCircle
                  : Circle;
  return (
    <span
      role="img"
      aria-label={status ? statusLabels[status] : "新会话"}
      title={status ? statusLabels[status] : "新会话"}
      className={cn(
        "inline-flex shrink-0",
        status === "completed"
          ? "text-primary/65"
          : status === "failed"
            ? "text-destructive"
            : "text-muted-foreground",
        className,
      )}
    >
      <Icon
        className={cn(
          "size-3.5",
          ["running", "planning", "verifying", "review"].includes(
            status ?? "",
          ) && "animate-spin motion-reduce:animate-none",
        )}
      />
    </span>
  );
}
