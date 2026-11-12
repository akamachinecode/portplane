import { useEffect, useRef } from "react";
import { useJobs } from "../api/jobs";
import { useApp } from "../components/AppContext";
import { usePrimePortless } from "../views/domains/store";
import { primeRunners } from "../views/runners/problems";
import { useShell } from "./ShellContext";

/**
 * Loads what the Health view needs beyond the snapshot, once, in the
 * background: portless's status and certificates, and dekit's runners. It
 * renders nothing.
 */
export function BackgroundData() {
  const { api } = useApp();
  const { snapshot } = useShell();
  const local = snapshot?.machines.find((m) => m.machine.local);
  usePrimePortless(!!local?.tools.portless);
  const dekit = !!local?.tools.dekit;
  useEffect(() => {
    if (dekit) void primeRunners(api);
  }, [api, dekit]);

  // A finished runner job changes what the runners look like.
  const { jobs } = useJobs();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = jobs.filter((j) => j.kind.startsWith("dekit") && j.state !== "running").map((j) => j.id);
    if (seen.current === null) {
      seen.current = new Set(done);
      return;
    }
    const fresh = done.filter((id) => !seen.current!.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    if (dekit) void primeRunners(api, true);
  }, [jobs, api, dekit]);
  return null;
}
