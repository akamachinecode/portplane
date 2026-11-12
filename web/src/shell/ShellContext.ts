import { createContext, useContext } from "react";
import type { ConnectionStatus } from "../api/events";
import type { Preferences, Snapshot } from "../api/types";
import type { Problem } from "./health";
import type { Route } from "../lib/router";
import type { Summary } from "../lib/summary";

export type PreferencesLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: Preferences };

/** The live state every view reads: the snapshot, the route, problems and preferences. */
export interface ShellData {
  snapshot: Snapshot | null;
  status: ConnectionStatus;
  route: Route;
  summary: Summary | null;
  /** From the snapshot and every registered problem source (health.ts). */
  problems: Problem[];
  preferences: PreferencesLoad;
  /**
   * Applies a change at once and saves the whole object. Resolves false when
   * the save failed: the change is rolled back and a toast says why.
   */
  updatePreferences(change: (p: Preferences) => Preferences): Promise<boolean>;
  reloadPreferences(): void;
}

export const ShellContext = createContext<ShellData | null>(null);

export function useShell(): ShellData {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell outside ShellContext");
  return ctx;
}
