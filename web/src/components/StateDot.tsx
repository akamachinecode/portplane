import type { State } from "../api/types";

/** The state at a glance. Always paired with the state's name in text. */
export function StateDot({ state }: { state: State | "online" | "connecting" | "offline" | "live" | "reconnecting" | "expired" }) {
  return <span className={`dot dot-${state}`} aria-hidden="true" />;
}
