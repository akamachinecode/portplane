import type { Api } from "./client";
import { createDekitHttp } from "./dekit";
import { ApiError } from "./errors";
import { machineHttp, type Http } from "./http";
import { createPortlessHttp } from "./portless";
import { createToolsHttp } from "./tools";
import type { ApplyResult, Proposal, SetupCheck } from "./types";

// Remote parity (ADR-0026): the guided setup, the dekit center and the
// portless center act on any machine. Api.forMachine(id) returns the same
// Api with those parts sent to /api/m/<id>/…, which Portplane serves for
// this computer or passes to that machine's agent over SSH. A view wraps
// its content in <MachineScope> to use it.

/** This computer's machine id in every snapshot. */
export const LOCAL_MACHINE = "local";

/** What forMachine replaces: the parts of the Api that act on one machine. */
export type MachineParts = Partial<Api>;

/**
 * The machine-scoped parts over HTTP. A remote machine's folders are its
 * settings (they live in Portplane's machine list), and it has no folder
 * picker: the path is typed.
 */
export function createMachineHttp(h: Http, api: Api, machine: string): MachineParts {
  const mh = machineHttp(h, machine);
  const { json } = mh;
  const settingsOf = async () => {
    const m = (await api.machines()).find((x) => x.id === machine);
    if (!m) throw new ApiError(`unknown machine "${machine}"`, 404);
    return m;
  };
  return {
    ...createPortlessHttp(mh),
    ...createDekitHttp(mh),
    ...createToolsHttp(mh),
    setupCheck: () => json<SetupCheck>("GET", "/api/setup/check"),
    setupScan: (folder, overrides) => json<Proposal>("POST", "/api/setup/scan", { folder, overrides }),
    setupApply: (folder, digest, overrides) => json<ApplyResult>("POST", "/api/setup/apply", { folder, digest, overrides }),
    settings: async () => ({ folders: (await settingsOf()).folders }),
    saveSettings: async (s) => ({ folders: (await api.updateMachine(machine, { folders: s.folders })).folders }),
    pickFolder: () => Promise.resolve({ kind: "unsupported" }),
  };
}

/**
 * Caches one scoped Api per machine, so views that depend on `api` keep a
 * stable one; "local" is the Api itself. A call a machine's agent can't
 * serve yet (501, agent-outdated) marks that machine (see
 * markAgentOutdated), so its views and Health offer to update the agent.
 */
export function machineScoper(api: () => Api, parts: (machine: string) => MachineParts): (machine: string) => Api {
  const cache = new Map<string, Api>();
  return (machine) => {
    const base = api();
    if (machine === LOCAL_MACHINE) return base;
    let scoped = cache.get(machine);
    if (!scoped) {
      scoped = { ...base, ...watchOutdated(machine, parts(machine)) };
      cache.set(machine, scoped);
    }
    return scoped;
  };
}

function watchOutdated(machine: string, parts: MachineParts): MachineParts {
  const out: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(parts)) {
    out[k] =
      typeof fn !== "function"
        ? fn
        : (...args: unknown[]) => {
            const res = (fn as (...a: unknown[]) => unknown)(...args);
            if (res instanceof Promise) {
              return res.catch((err: unknown) => {
                if (isAgentOutdated(err)) markAgentOutdated(machine);
                throw err;
              });
            }
            return res;
          };
  }
  return out as MachineParts;
}

/** An agent older than this Portplane answers 501: it can't serve the machine API yet. */
export function isAgentOutdated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 501;
}

// ---- machines whose agent is older than this Portplane ----
//
// Known only from an answer: the agent's version string can't say whether
// it serves the machine API (a development build talks to a released
// agent). The mark lasts until the machine reconnects (updating the agent
// reconnects it), when the next call finds out again.

const outdated = new Set<string>();
const outdatedListeners = new Set<() => void>();
let outdatedVersion = 0;

function changedOutdated(): void {
  outdatedVersion++;
  for (const l of outdatedListeners) l();
}

export function markAgentOutdated(machine: string): void {
  if (outdated.has(machine)) return;
  outdated.add(machine);
  changedOutdated();
}

export function clearAgentOutdated(machine: string): void {
  if (outdated.delete(machine)) changedOutdated();
}

/** Whether a call to the machine found its agent older than this Portplane. */
export function agentIsOutdated(machine: string): boolean {
  return outdated.has(machine);
}

/** For useSyncExternalStore: changes whenever a machine is marked or cleared. */
export function subscribeOutdated(listener: () => void): () => void {
  outdatedListeners.add(listener);
  return () => outdatedListeners.delete(listener);
}

export function outdatedSnapshot(): number {
  return outdatedVersion;
}
