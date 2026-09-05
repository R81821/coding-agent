import { useEffect, useState } from "react";

const GRID_CELLS = Array.from({ length: 40 }, (_, index) => index);

export function BuiLoadingState({ label = "正在运行" }: { label?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="glass p-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">{label}</span>
        <span className="font-mono text-xs text-text-muted">{seconds}s</span>
      </div>
      <div className="mt-3 grid grid-cols-10 gap-1" aria-hidden="true">
        {GRID_CELLS.map((index) => (
          <div
            key={index}
            className="aspect-square rounded-[3px] bg-white/5 animate-shimmer bg-[linear-gradient(110deg,transparent_30%,rgba(147,197,253,0.28)_50%,transparent_70%)] bg-[length:200%_100%]"
            style={{ animationDelay: `${(index % 10) * 60}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
