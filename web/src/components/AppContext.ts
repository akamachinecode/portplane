import { createContext, useContext } from "react";
import type { Api } from "../api/client";
import type { Info, Machine } from "../api/types";
import type { Pending } from "../hooks/usePending";
import type { Toaster } from "../hooks/useToasts";

export interface AppCtx {
  api: Api;
  info: Info | null;
  toast: Toaster;
  pending: Pending;
  openSettings(): void;
  /** Opens setup for a watched folder, on this computer unless machine says another (ADR-0026). */
  openSetup(folder: string, machine?: string): void;
  openAddMachine(): void;
  openEditMachine(id: string): void;
  openRemoveMachine(machine: Machine): void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
