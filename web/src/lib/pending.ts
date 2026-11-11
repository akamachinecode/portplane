import type { Snapshot } from "../api/types";

// Optimistic feedback for actions: the clicked button spins until the next
// snapshot shows a change in what it acted on, or until PENDING_TIMEOUT.

export const PENDING_TIMEOUT = 10_000;

export interface PendingEntry {
  key: string;
  startedAt: number;
  baseline: string;
  fingerprint: (snapshot: Snapshot) => string;
}

/** Everything about these apps that an action changes. The pid catches a fast restart. */
export function appsFingerprint(machine: string, appIds: string[]) {
  const ids = new Set(appIds);
  return (snapshot: Snapshot): string => {
    const ms = snapshot.machines.find((m) => m.machine.id === machine);
    if (!ms) return "";
    return ms.apps
      .filter((a) => ids.has(a.id))
      .map((a) => `${a.id}=${a.state}/${a.rawState ?? ""}/${a.pid ?? ""}`)
      .join("|");
  };
}

export function runnerFingerprint(machine: string, root: string) {
  return (snapshot: Snapshot): string => {
    const ms = snapshot.machines.find((m) => m.machine.id === machine);
    const r = ms?.runners.find((x) => x.root === root);
    return r ? `${r.up}/${r.error ?? ""}` : "";
  };
}

/** Drops entries whose target changed in this snapshot, or that waited too long. */
export function prunePending(entries: PendingEntry[], snapshot: Snapshot | null, now: number): PendingEntry[] {
  const kept = entries.filter(
    (e) => now - e.startedAt < PENDING_TIMEOUT && (!snapshot || e.fingerprint(snapshot) === e.baseline),
  );
  return kept.length === entries.length ? entries : kept;
}

/** Milliseconds until the oldest entry times out, or undefined when there is none. */
export function nextExpiry(entries: PendingEntry[], now: number): number | undefined {
  if (entries.length === 0) return undefined;
  const first = Math.min(...entries.map((e) => e.startedAt));
  return Math.max(0, first + PENDING_TIMEOUT - now);
}
