import type { Snapshot, State } from "../api/types";
import { isVisible } from "./apps";

// What a screen reader hears when apps change state (a polite live region,
// shell/Announcer.tsx). Only what changed, in a sentence; many changes at
// once become a count, so a "Start all" does not read out every app.

const WORDS: Partial<Record<State, string>> = {
  on: "is running",
  starting: "is starting",
  stopping: "is stopping",
  failed: "failed",
  off: "stopped",
  done: "finished",
};

/** At most this many changes are named one by one. */
const NAMED = 3;

export function announceChanges(prev: Snapshot | null, next: Snapshot): string {
  if (!prev) return "";
  const before = new Map<string, State>();
  for (const ms of prev.machines) for (const a of ms.apps) before.set(`${ms.machine.id}|${a.id}`, a.state);
  const changes: Array<{ label: string; state: State }> = [];
  for (const ms of next.machines) {
    for (const a of ms.apps) {
      const was = before.get(`${ms.machine.id}|${a.id}`);
      if (was === undefined || was === a.state || !isVisible(a) || !WORDS[a.state]) continue;
      changes.push({ label: ms.machine.local ? a.label : `${a.label} on ${ms.machine.name}`, state: a.state });
    }
  }
  if (changes.length === 0) return "";
  if (changes.length <= NAMED) return changes.map((c) => `${c.label} ${WORDS[c.state]}.`).join(" ");
  const counts = new Map<State, number>();
  for (const c of changes) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const parts = [...counts.entries()].map(([state, n]) => `${n} ${WORDS[state]?.replace(/^is /, "")}`);
  return `${changes.length} apps changed: ${parts.join(", ")}.`;
}
