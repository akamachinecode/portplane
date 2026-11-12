import { useSyncExternalStore } from "react";
import type { UpdateCheck, UpdateItem } from "../api/polish";
import type { Preferences } from "../api/types";

// The last update check (GET /api/updates), shared by the sidebar's notice
// and Settings › Updates, so a check in one shows in the other. undefined
// until it loads; null before the first check ever.

let last: UpdateCheck | null | undefined;
const listeners = new Set<() => void>();

export function setUpdateCheck(check: UpdateCheck | null): void {
  last = check;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last check, live. */
export function useUpdateCheck(): UpdateCheck | null | undefined {
  return useSyncExternalStore(subscribe, () => last);
}

/** The new Portplane the check found, if any. */
export function portplaneUpdate(check: UpdateCheck | null | undefined): UpdateItem | undefined {
  return check?.items.find((i) => i.id === "portplane" && i.update && !i.error && !!i.latest);
}

/**
 * Whether to ask, once, if Portplane may check once a day (ADR-0031): the
 * user hasn't answered, checks are still manual, and the setup checklist
 * isn't asking for attention first.
 */
export function shouldAskAboutUpdates(prefs: Preferences | null, setupLeft: boolean): boolean {
  return !!prefs && !prefs.updateAsked && prefs.updateCheck === "manual" && !setupLeft;
}
