import { createContext, useContext } from "react";
import type { Api } from "../api/client";
import type { Info } from "../api/types";
import type { Pending } from "../hooks/usePending";
import type { Toaster } from "../hooks/useToasts";

export interface AppCtx {
  api: Api;
  info: Info | null;
  toast: Toaster;
  pending: Pending;
  openSettings(): void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
