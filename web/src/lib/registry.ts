import { useSyncExternalStore } from "react";

// A small keyed list that other files add to and the UI re-renders from:
// command sources (shell/commands.ts) and problem sources (shell/health.ts).

export interface Registry<T> {
  /** Adds (or replaces) an entry; the returned function removes it again. */
  register(id: string, item: T): () => void;
  /** In registration order. */
  values(): T[];
  /** Re-renders a component whenever an entry comes or goes. */
  useVersion(): number;
  /** Tells subscribers that an entry's output changed (its own state moved on). */
  invalidate(): void;
}

export function createRegistry<T>(): Registry<T> {
  const items = new Map<string, T>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return {
    register(id, item) {
      items.set(id, item);
      changed();
      return () => {
        if (items.get(id) !== item) return; // replaced since
        items.delete(id);
        changed();
      };
    },
    values: () => [...items.values()],
    useVersion: () => useSyncExternalStore(subscribe, () => version),
    invalidate: changed,
  };
}
