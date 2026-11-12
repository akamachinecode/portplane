import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RunnersResponse } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useJobs } from "../../api/jobs";
import { useApp } from "../../components/AppContext";
import { useShell } from "../../shell/ShellContext";

export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T; refreshing: boolean };

/**
 * GET /api/dekit/runners, fetched again when the snapshot changes (a runner
 * went up or down) and when a dekit job ends.
 */
export function useRunners(): { load: Load<RunnersResponse>; reload(): void } {
  const { api } = useApp();
  const { snapshot } = useShell();
  const { jobs } = useJobs();
  const [load, setLoad] = useState<Load<RunnersResponse>>({ status: "loading" });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoad((l) => (l.status === "ok" ? { ...l, refreshing: true } : l));
    api.dekitRunners().then(
      (value) => n === seq.current && setLoad({ status: "ok", value, refreshing: false }),
      (err: unknown) => n === seq.current && setLoad({ status: "error", message: errorText(err) }),
    );
  }, [api]);
  const local = snapshot?.machines.find((m) => m.machine.local);
  const runnersKey = local ? local.runners.map((r) => `${r.root}:${r.up}`).join("|") + `|${local.tools.dekit ?? ""}` : "";
  const doneKey = jobs
    .filter((j) => j.kind.startsWith("dekit") && j.state !== "running")
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    reload();
  }, [reload, runnersKey, doneKey]);
  return { load, reload };
}

// The job each runner's last action started, kept across navigation.
const runnerJobs = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function setRunnerJob(root: string, id: string | null): void {
  if (id) runnerJobs.set(root, id);
  else runnerJobs.delete(root);
  version++;
  for (const l of listeners) l();
}

export function useRunnerJob(root: string): string | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return runnerJobs.get(root);
}
