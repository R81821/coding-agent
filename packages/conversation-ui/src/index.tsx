import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
export { useSessionContent } from "./content.js";

export interface ConversationPosition { offset: number; measurements: VirtualItem[]; atEnd: boolean }

/** Match the six-session preview cache; measured rows must not accumulate across every visited session. */
export class ConversationPositions {
  private entries = new Map<string, ConversationPosition>();
  get(id: string) {
    const value = this.entries.get(id);
    if (value) { this.entries.delete(id); this.entries.set(id, value); }
    return value;
  }
  set(id: string, value: ConversationPosition) {
    this.entries.delete(id); this.entries.set(id, value);
    while (this.entries.size > 6) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(id: string) { this.entries.delete(id); }
  clear() { this.entries.clear(); }
}

// Row state belongs to the conversation, not the mounted window of visible rows.
// Nothing is persisted to browser storage; releasing the conversation releases this store.
class RowState {
  values = new Map<string, unknown>();
  listeners = new Map<string, Set<() => void>>();
  read<T>(key: string, initial: T | (() => T)): T {
    if (!this.values.has(key)) this.values.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return this.values.get(key) as T;
  }
  write<T>(key: string, initial: T | (() => T), action: SetStateAction<T>) {
    const previous = this.read(key, initial);
    const next = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
    if (Object.is(previous, next)) return;
    this.values.set(key, next); this.listeners.get(key)?.forEach(listener => listener());
  }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
}
const RowContext = createContext<RowState | undefined>(undefined);
export function useRowState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const shared = useContext(RowContext);
  const fallback = useRef<RowState | undefined>(undefined);
  const store = shared ?? (fallback.current ??= new RowState());
  const initialRef = useRef(initial);
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key]);
  const snapshot = useCallback(() => store.read(key, initialRef.current), [store, key]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback((action: SetStateAction<T>) => store.write(key, initialRef.current, action), [store, key]);
  return [value, setValue];
}

export function VirtualConversation<T>({ items, itemKey, renderItem, header, className, contentClassName, initialPosition, onPosition, onVisibleItems, label = "对话消息" }: {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  header?: ReactNode;
  className?: string;
  contentClassName?: string;
  initialPosition?: ConversationPosition | undefined;
  onPosition?: ((position: ConversationPosition) => void) | undefined;
  onVisibleItems?: ((ids: string[]) => void) | undefined;
  label?: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const states = useRef(new Map<string, RowState>());
  const [below, setBelow] = useState(false);
  const initialized = useRef(false);
  const onPositionRef = useRef(onPosition); onPositionRef.current = onPosition;
  const visibleRef = useRef(onVisibleItems); visibleRef.current = onVisibleItems;
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const getItemKey = useCallback((index: number) => index === 0 ? "conversation-header" : keys[index - 1]!, [keys]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length + 1,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: index => index === 0 ? 44 : 420,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 3,
    initialOffset: initialPosition?.offset ?? 0,
    initialMeasurementsCache: initialPosition?.measurements ?? [],
    onChange: instance => {
      setBelow(!instance.isAtEnd());
    },
  });
  const visibleKeys = virtual.getVirtualItems().filter(row => row.index > 0).map(row => String(row.key));
  const visibleSignature = JSON.stringify(visibleKeys);
  useEffect(() => { visibleRef.current?.(JSON.parse(visibleSignature) as string[]); }, [visibleSignature]);
  useLayoutEffect(() => {
    if (!items.length || initialized.current) return;
    initialized.current = true;
    if (!initialPosition || initialPosition.atEnd) virtual.scrollToEnd();
    else virtual.scrollToOffset(initialPosition.offset);
  }, [items.length, virtual, initialPosition]);
  // Save measured sizes with the offset, so switching back does not restore against estimates.
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let frame = 0;
    const save = () => {
      if (!initialized.current) return;
      onPositionRef.current?.({ offset: element.scrollTop, measurements: virtual.takeSnapshot(), atEnd: virtual.isAtEnd() });
    };
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(save); };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); save(); element.removeEventListener("scroll", onScroll); };
  }, [virtual]);
  return <div style={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0 }}>
    <div ref={scroll} className={className} aria-label={label} style={{ height: "100%", overflowY: "auto", overflowAnchor: "none", paddingTop: 0, paddingBottom: 0 }}>
      {/* Rows are absolutely positioned, so this element contributes no intrinsic width. Stating the
          width keeps it full-bleed when a consumer makes the scroll container a flex box. */}
      <div className={contentClassName} style={{ width: "100%" }}>
        <div data-virtual-conversation="true" style={{ height: virtual.getTotalSize(), width: "100%", position: "relative" }}>
          {virtual.getVirtualItems().map(row => {
            const id = String(row.key);
            let state = states.current.get(id);
            if (!state) { state = new RowState(); states.current.set(id, state); }
            return <div key={row.key} data-index={row.index} data-virtual-row={id} ref={virtual.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", display: "flow-root", paddingTop: row.index === 0 ? 24 : 0, paddingBottom: 24, transform: `translateY(${row.start}px)` }}>
              <RowContext.Provider value={state}>{row.index === 0 ? header : renderItem(items[row.index - 1]!, row.index - 1)}</RowContext.Provider>
            </div>;
          })}
        </div>
      </div>
    </div>
    {below && items.length > 0 && <button type="button" aria-label="回到最新消息" onClick={() => virtual.scrollToEnd()}
      style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", padding: "6px 14px", borderRadius: 20, background: "var(--color-bg-elevated, var(--background, white))", border: "1px solid var(--color-border, var(--border, #ccc))", color: "inherit", cursor: "pointer" }}>↓ 回到最新消息</button>}
  </div>;
}
