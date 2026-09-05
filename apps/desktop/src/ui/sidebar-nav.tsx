import React from "react";

export function BuiSidebarNav<T extends string>({
  items,
  active,
  onSelect,
}: {
  items: Array<{ id: T; label: string; icon: React.ReactNode; badge?: number }>;
  active: T;
  onSelect: (item: T) => void;
}) {
  return (
    <nav className="flex flex-col gap-1 p-2" aria-label="主导航">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={active === item.id ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
            active === item.id
              ? "bg-accent-soft text-accent-text"
              : "text-text-muted hover:bg-white/5 hover:text-text"
          }`}
          onClick={() => onSelect(item.id)}
        >
          {item.icon}
          <span className="flex-1 text-left">{item.label}</span>
          {Boolean(item.badge) && (
            <em className="not-italic rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {item.badge}
            </em>
          )}
        </button>
      ))}
    </nav>
  );
}
