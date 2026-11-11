import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../api/errors";
import type { Snapshot } from "../api/types";
import { nextExpiry, prunePending, type PendingEntry } from "../lib/pending";
import type { Toaster } from "./useToasts";

export interface Pending {
  has(key: string): boolean;
  /** Any pending key that starts with prefix: e.g. every action on one app. */
  hasPrefix(prefix: string): boolean;
  /**
   * Runs an action with key marked as pending. With a fingerprint, the mark
   * stays until the next snapshot changes what it returns (or a timeout);
   * without one, until the request ends. Errors become toasts.
   */
  run(key: string, fingerprint: ((s: Snapshot) => string) | null, action: () => Promise<unknown>): Promise<void>;
}

export function usePending(snapshot: Snapshot | null, toast: Toaster): Pending {
  const [entries, setEntries] = useState<PendingEntry[]>([]);
  const snapshotRef = useRef(snapshot);
  const entriesRef = useRef(entries);
  snapshotRef.current = snapshot;
  entriesRef.current = entries;

  useEffect(() => {
    setEntries((e) => prunePending(e, snapshot, Date.now()));
  }, [snapshot]);

  useEffect(() => {
    const wait = nextExpiry(entries, Date.now());
    if (wait === undefined) return;
    const t = setTimeout(() => setEntries((e) => prunePending(e, null, Date.now())), wait + 20);
    return () => clearTimeout(t);
  }, [entries]);

  const remove = useCallback((key: string) => setEntries((e) => e.filter((x) => x.key !== key)), []);

  const run = useCallback<Pending["run"]>(
    async (key, fingerprint, action) => {
      if (entriesRef.current.some((e) => e.key === key)) return; // a double click
      const fp = fingerprint ?? (() => "");
      const snap = snapshotRef.current;
      const entry: PendingEntry = { key, startedAt: Date.now(), baseline: snap ? fp(snap) : "", fingerprint: fp };
      entriesRef.current = [...entriesRef.current, entry];
      setEntries((e) => [...e.filter((x) => x.key !== key), entry]);
      try {
        await action();
        if (!fingerprint) remove(key);
      } catch (err) {
        remove(key);
        toast.error(errorText(err));
      }
    },
    [remove, toast],
  );

  return useMemo<Pending>(() => {
    const keys = entries.map((e) => e.key);
    return {
      has: (key) => keys.includes(key),
      hasPrefix: (prefix) => keys.some((k) => k.startsWith(prefix)),
      run,
    };
  }, [entries, run]);
}
