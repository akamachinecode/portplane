import { useCallback, useMemo, useState } from "react";
import { safeLocalStorage } from "../lib/storage";

// Which project and worktree groups the user folded or unfolded, by key,
// over each group's default (a linked worktree with nothing running starts
// folded). A per-browser convenience, kept in localStorage.

const KEY = "portplane.apps.folds";

function read(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(safeLocalStorage()?.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

// Shared by every list on the page, so the Apps view and a project page agree.
let folds: Record<string, boolean> | null = null;

export interface Folds {
  isFolded(key: string, byDefault: boolean): boolean;
  setFolded(key: string, folded: boolean): void;
}

export function useFolds(): Folds {
  const [state, setState] = useState<Record<string, boolean>>(() => (folds ??= read()));
  const isFolded = useCallback((key: string, byDefault: boolean) => state[key] ?? byDefault, [state]);
  const setFolded = useCallback((key: string, folded: boolean) => {
    setState((cur) => {
      const next = { ...cur, [key]: folded };
      folds = next;
      try {
        safeLocalStorage()?.setItem(KEY, JSON.stringify(next));
      } catch {
        // storage blocked: it lasts until the page reloads
      }
      return next;
    });
  }, []);
  return useMemo(() => ({ isFolded, setFolded }), [isFolded, setFolded]);
}

export function projectFoldKey(machine: string, runner: string, project: string): string {
  return `p|${machine}|${runner}|${project}`;
}

export function worktreeFoldKey(machine: string, runner: string, project: string, worktree: string): string {
  return `w|${machine}|${runner}|${project}|${worktree}`;
}
