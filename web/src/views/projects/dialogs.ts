import { useSyncExternalStore } from "react";

// Dialogs of the Projects view that the palette opens from anywhere: the
// command goes to Projects (with the runner chosen) and asks for the dialog.

export type ProjectDialog = { kind: "add-app"; runner?: string } | { kind: "run-command"; runner?: string; cwd?: string } | { kind: "reload"; runner: string };

let current: ProjectDialog | null = null;
const listeners = new Set<() => void>();

export function openProjectDialog(d: ProjectDialog | null): void {
  current = d;
  for (const l of listeners) l();
}

export function useProjectDialog(): ProjectDialog | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
