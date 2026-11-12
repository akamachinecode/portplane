import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText } from "../api/errors";
import { agentIsOutdated, LOCAL_MACHINE, outdatedSnapshot, subscribeOutdated } from "../api/machine";
import type { MachineSnapshot, Snapshot } from "../api/types";
import { chosenMachine, pickableMachines, rememberedMachine, rememberMachine, sshCommand, type MachineOption } from "../lib/machineScope";
import { navigate } from "../lib/router";
import { safeLocalStorage } from "../lib/storage";
import { useShell } from "../shell/ShellContext";
import { AppContext, useApp } from "./AppContext";
import { Banner } from "./Banner";
import { Spinner } from "./Icon";
import "./MachineScope.css";

// Remote parity (ADR-0026): a view picks a machine, and everything inside
// <MachineScope> acts on it. useApp().api there is api.forMachine(id), so
// sections and dialogs need no machine parameter; useScopedMachine() is
// that machine's snapshot.

interface Scope {
  id: string;
  /** The machine's snapshot; null until it shows up. */
  ms: MachineSnapshot | null;
  remote: boolean;
  /** The SSH destination of a remote machine, for commands to copy. */
  host?: string;
}

const ScopeContext = createContext<Scope | null>(null);

/** The machine the surrounding scope acts on; this computer outside one. */
export function useMachineScope(): Scope {
  const scope = useContext(ScopeContext);
  const { snapshot } = useShell();
  if (scope) return scope;
  return { id: LOCAL_MACHINE, ms: snapshot?.machines.find((m) => m.machine.local) ?? null, remote: false };
}

/**
 * How to show a command to run by hand: as it is on this computer, through
 * `ssh -t <host> '…'` on a machine over SSH (ADR-0026).
 */
export function useRemoteCommand(): (command: string) => string {
  const { remote, host } = useMachineScope();
  return useCallback((command: string) => (remote ? sshCommand(host, command) : command), [remote, host]);
}

/** The scoped machine's snapshot (this computer's outside a scope). */
export function useScopedMachine(): MachineSnapshot | null {
  return useMachineScope().ms;
}

// The SSH destinations, read once per page load (again for a machine added since).
let hosts: Promise<Record<string, string>> | null = null;

function useHost(api: { machines(): Promise<Array<{ id: string; host: string }>> }, id: string, remote: boolean): string | undefined {
  const [host, setHost] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!remote) return;
    let live = true;
    const read = () =>
      api.machines().then(
        (list) => Object.fromEntries(list.map((m) => [m.id, m.host])),
        () => {
          hosts = null;
          return {} as Record<string, string>;
        },
      );
    hosts ??= read();
    void hosts
      .then((h) => (id in h ? h : (hosts = read())))
      .then((h) => live && setHost(h[id]));
    return () => {
      live = false;
    };
  }, [api, id, remote]);
  return host;
}

/** Children act on one machine (ADR-0026). */
export function MachineScope({ machine, children }: { machine: string; children: ReactNode }) {
  const app = useApp();
  const { snapshot } = useShell();
  const api = useMemo(() => app.api.forMachine(machine), [app.api, machine]);
  const ms = snapshot?.machines.find((m) => m.machine.id === machine) ?? null;
  const remote = machine !== LOCAL_MACHINE && !ms?.machine.local;
  // No folder picker for a machine over SSH: its paths are typed.
  const info = useMemo(() => (remote && app.info ? { ...app.info, picker: false } : app.info), [remote, app.info]);
  const ctx = useMemo(() => ({ ...app, api, info }), [app, api, info]);
  const host = useHost(app.api, machine, remote);
  const scope = useMemo<Scope>(() => ({ id: machine, ms, remote, host }), [machine, ms, remote, host]);
  return (
    <AppContext value={ctx}>
      <ScopeContext value={scope}>{children}</ScopeContext>
    </AppContext>
  );
}

/**
 * The machine Runners or Domains acts on: the one in the URL
 * (#/runners/<machine>), else the one last picked there, else this
 * computer. Picking one remembers it, and updates a URL that names one.
 */
export function useMachineChoice(view: "runners" | "domains"): { machine: string; options: MachineOption[]; choose(id: string): void } {
  const { snapshot, route } = useShell();
  const inUrl = route.view === view ? route.machine : undefined;
  const [picked, setPicked] = useState(() => rememberedMachine(safeLocalStorage(), view));
  const options = useMemo(() => pickableMachines(snapshot), [snapshot]);
  const { machine, urlMachine } = chosenMachine(inUrl, picked, options, !!snapshot);
  useEffect(() => {
    if (!urlMachine) return;
    rememberMachine(safeLocalStorage(), view, urlMachine);
    setPicked(urlMachine);
  }, [urlMachine, view]);
  const choose = useCallback(
    (id: string) => {
      setPicked(id);
      rememberMachine(safeLocalStorage(), view, id);
      if (route.view === view && route.machine) navigate({ ...route, machine: id }, { replace: true });
    },
    [view, route],
  );
  return { machine, options, choose };
}

/** "Machine: [This computer ▾]", shown only when there is another machine. */
export function MachinePicker({
  machine,
  options,
  onChange,
  label = "Machine",
}: {
  machine: string;
  options: MachineOption[];
  onChange(id: string): void;
  label?: string;
}) {
  if (options.length < 2) return null;
  return (
    <label className="machine-picker">
      <span className="machine-picker-label">{label}</span>
      <select className="machine-picker-select" value={machine} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={!o.online}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whether a call to the machine found its agent older than this Portplane. */
export function useAgentOutdated(machine: string): boolean {
  useSyncExternalStore(subscribeOutdated, outdatedSnapshot);
  return agentIsOutdated(machine);
}

/**
 * What a remote machine's view says above its content: offline, or an
 * agent older than this Portplane (with the button that updates it).
 */
export function RemoteStatusBanner({ className }: { className?: string }) {
  const { ms, remote, id } = useMachineScope();
  const { api, toast } = useApp();
  const outdated = useAgentOutdated(id);
  const [busy, setBusy] = useState(false);
  if (!remote || !ms) return null;
  const m = ms.machine;
  if (m.status !== "online") {
    return (
      <div className={className}>
        <Banner tone="warn" title={`${m.name} is ${m.status === "connecting" ? "connecting" : "offline"}`}>
          {m.status === "connecting" ? "Portplane is reaching it over SSH." : "Portplane reconnects on its own. What you see here comes back once it's online."}
          {m.error && <span className="mono"> {m.error}</span>}
        </Banner>
      </div>
    );
  }
  if (!outdated) return null;
  const update = async () => {
    setBusy(true);
    try {
      await api.updateAgent(id);
      toast.info(`Updating the agent on ${m.name}: it reconnects in a moment`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <Banner
        tone="warn"
        title={`Update the agent on ${m.name}`}
        action={
          <button type="button" className="btn" onClick={() => void update()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner size={12} />}
            Update the agent
          </button>
        }
      >
        {m.name} runs Portplane's agent{m.agent ? ` ${m.agent}` : ""}, older than this Portplane. Setup, dekit and portless on {m.name} need this Portplane's
        version: updating uploads it again over SSH and reconnects.
      </Banner>
    </div>
  );
}

/** The machine's display name for sentences: "this computer" or its name. */
export function machineLabel(ms: MachineSnapshot | null, capital = false): string {
  if (!ms || ms.machine.local) return capital ? "This computer" : "this computer";
  return ms.machine.name;
}

export type { MachineOption, Snapshot };
