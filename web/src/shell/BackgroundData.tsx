import { useEffect, useRef } from "react";
import { useJobs } from "../api/jobs";
import { agentIsOutdated, clearAgentOutdated, LOCAL_MACHINE } from "../api/machine";
import type { Snapshot } from "../api/types";
import { useApp } from "../components/AppContext";
import { primePortless, useLivePortless, usePrimePortless } from "../views/domains/store";
import { forgetRunners, primeRunners } from "../views/runners/problems";
import { useShell } from "./ShellContext";

/**
 * Loads what the Health view needs beyond the snapshot, once, in the
 * background: portless's status and certificates, and dekit's runners, on
 * this computer and on each machine over SSH while it is online (ADR-0026).
 * It renders nothing.
 */
export function BackgroundData() {
  const { api } = useApp();
  const { snapshot } = useShell();
  const local = snapshot?.machines.find((m) => m.machine.local);
  usePrimePortless(!!local?.tools.portless);
  useLivePortless(snapshot?.machines);
  const dekit = !!local?.tools.dekit;
  useEffect(() => {
    if (dekit) void primeRunners(api);
  }, [api, dekit]);
  useRemoteMachines(snapshot);

  // A finished runner job changes what the runners look like.
  const { jobs } = useJobs();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = jobs.filter((j) => j.kind.startsWith("dekit") && j.state !== "running");
    if (seen.current === null) {
      seen.current = new Set(done.map((j) => j.id));
      return;
    }
    const fresh = done.filter((j) => !seen.current!.has(j.id));
    if (fresh.length === 0) return;
    for (const j of fresh) seen.current.add(j.id);
    for (const machine of new Set(fresh.map((j) => j.machine ?? LOCAL_MACHINE))) {
      if (machine === LOCAL_MACHINE) {
        if (dekit) void primeRunners(api, true);
      } else if (snapshot?.machines.some((m) => m.machine.id === machine && m.machine.status === "online" && m.tools.dekit)) {
        void primeRunners(api.forMachine(machine), true, machine);
      }
    }
  }, [jobs, api, dekit, snapshot]);
  return null;
}

/** Each connection to a remote machine: its id, and the agent that answered. */
export function remoteSessions(snapshot: Snapshot | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const ms of snapshot?.machines ?? []) {
    const m = ms.machine;
    if (m.local || m.status !== "online") continue;
    out.set(m.id, `${m.agent ?? ""}|${ms.tools.dekit ?? ""}|${ms.tools.portless ?? ""}`);
  }
  return out;
}

/**
 * Loads a remote machine's portless and runner state once per connection
 * (and again when its tools change), and forgets it while the machine is
 * away; a machine that reconnects may run another agent, so the "update
 * the agent" mark goes too.
 */
function useRemoteMachines(snapshot: Snapshot | null) {
  const { api } = useApp();
  const primed = useRef(new Map<string, string>());
  useEffect(() => {
    const now = remoteSessions(snapshot);
    for (const [id] of primed.current) {
      if (now.has(id)) continue;
      primed.current.delete(id);
      forgetRunners(id);
      if (agentIsOutdated(id)) clearAgentOutdated(id);
    }
    for (const [id, session] of now) {
      if (primed.current.get(id) === session) continue;
      primed.current.set(id, session);
      const ms = snapshot!.machines.find((m) => m.machine.id === id)!;
      const remote = api.forMachine(id);
      if (ms.tools.portless) primePortless(remote, id, true);
      if (ms.tools.dekit) void primeRunners(remote, true, id);
    }
  }, [api, snapshot]);
}
