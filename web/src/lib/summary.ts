import type { Snapshot } from "../api/types";
import { isVisible } from "./apps";

export interface Summary {
  running: number; // services that are up
  starting: number;
  stopping: number;
  failed: number;
}

/** Counts what the user sees: hidden jobs (finished installs) do not count. */
export function summarize(snapshot: Snapshot): Summary {
  const s: Summary = { running: 0, starting: 0, stopping: 0, failed: 0 };
  for (const m of snapshot.machines) {
    for (const app of m.apps) {
      if (!isVisible(app)) continue;
      switch (app.state) {
        case "on":
          if (app.kind !== "job") s.running++;
          break;
        case "starting":
          s.starting++;
          break;
        case "stopping":
          s.stopping++;
          break;
        case "failed":
          s.failed++;
          break;
      }
    }
  }
  return s;
}

/** The tab title, so the state shows even when the window is in the background. */
export function documentTitle(s: Summary | null): string {
  if (!s) return "Portplane";
  const parts: string[] = [];
  if (s.running) parts.push(`${s.running} running`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.length ? `Portplane · ${parts.join(", ")}` : "Portplane";
}
