import type { ReactNode } from "react";
import type { Snapshot } from "../api/types";
import { ErrorState, LoadingState } from "../components/States";
import { useShell } from "./ShellContext";

/** Renders children once the first snapshot is in; until then, loading or the connection's error. */
export function SnapshotGate({ children }: { children(snapshot: Snapshot): ReactNode }) {
  const { snapshot, status } = useShell();
  if (snapshot) return <>{children(snapshot)}</>;
  if (status === "expired") return null; // the Reload banner says it all
  if (status === "reconnecting") return <ErrorState title="Can't reach Portplane" message="Retrying in the background…" />;
  return <LoadingState label="Connecting to Portplane…" />;
}
