import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RunnersResponse } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useJobs } from "../../api/jobs";
import { useApp } from "../../components/AppContext";
import { useMachineScope } from "../../components/MachineScope";

export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T; refreshing: boolean };

/**
 * GET /api/dekit/runners, fetched again when the snapshot changes (a runner
 * went up or down) and when a dekit job ends.
 */
export function useRunners(): { load: Load<RunnersResponse>; reload(): void } {
  const { api } = useApp();
  const { id: machine, ms: local } = useMachineScope();
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
  const runnersKey = local ? local.runners.map((r) => `${r.root}:${r.up}`).join("|") + `|${local.tools.dekit ?? ""}` : "";
  const doneKey = jobs
    .filter((j) => j.kind.startsWith("dekit") && j.state !== "running" && (j.machine ?? "local") === machine)
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    reload();
  }, [reload, runnersKey, doneKey]);
  return { load, reload };
}

// The job each runner's last action started, per machine, kept across
// navigation.
const runnerJobs = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function setRunnerJob(machine: string, root: string, id: string | null): void {
  const key = `${machine}|${root}`;
  if (id) runnerJobs.set(key, id);
  else runnerJobs.delete(key);
  version++;
  for (const l of listeners) l();
}

export function useRunnerJob(machine: string, root: string): string | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return runnerJobs.get(`${machine}|${root}`);
}
