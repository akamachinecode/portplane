import { createDekitHttp, type DekitApi } from "./dekit";
import { connectFeed, type FeedHandlers } from "./events";
import { createHttp, seg, type FetchLike } from "./http";
import type { Job } from "./jobs";
import { createPolishHttp, type PolishApi } from "./polish";
import { createPortlessHttp, type PortlessApi } from "./portless";
import { createToolsHttp, type ToolsApi } from "./tools";
import type {
  ApplyResult,
  Autostart,
  Excerpt,
  Info,
  MachineCandidate,
  MachineSettings,
  MachineUpdate,
  NewMachine,
  Preferences,
  Proposal,
  Settings,
  SetupCheck,
  SetupOverrides,
  Snapshot,
  Target,
  TaskOutput,
  Verb,
} from "./types";

export { ApiError } from "./errors";
export { TOKEN_HEADER, UNREACHABLE } from "./http";

export type PickResult = { kind: "picked"; path: string } | { kind: "cancelled" } | { kind: "unsupported" };

/**
 * Everything the UI needs from the binary. The mock in mock.ts implements the
 * same interface. The portless, dekit and tools parts live in their own
 * modules (portless.ts, dekit.ts, tools.ts), each with an HTTP factory and a
 * mock factory, so work on one does not touch this file.
 */
export interface Api extends PortlessApi, DekitApi, ToolsApi, PolishApi {
  info(): Promise<Info>;
  snapshot(): Promise<Snapshot>;
  act(target: Target, verb: Verb): Promise<void>;
  runnerUp(machine: string, runner: string): Promise<void>;
  excerpt(machine: string, runner: string, task: string): Promise<Excerpt>;
  /** An app's whole screen with its colours (the Output panel asks once a second while open). */
  output(machine: string, runner: string, task: string, signal?: AbortSignal): Promise<TaskOutput>;
  open(machine: string, urls: string[]): Promise<void>;
  reveal(machine: string, path: string): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  pickFolder(): Promise<PickResult>;

  /** What setup needs on this computer (ADR-0014). */
  setupCheck(): Promise<SetupCheck>;
  /** Scans a watched folder and proposes tasks; read-only. */
  setupScan(folder: string, overrides: SetupOverrides): Promise<Proposal>;
  /** Writes what a scan proposed. Fails with 409 when the folder changed since (see isStale). */
  setupApply(folder: string, digest: string, overrides: SetupOverrides): Promise<ApplyResult>;

  machines(): Promise<MachineSettings[]>;
  machineCandidates(): Promise<MachineCandidate[]>;
  /** Tests SSH and installs the agent: can take minutes. Aborting the signal cancels it. */
  addMachine(machine: NewMachine, signal?: AbortSignal): Promise<MachineSettings>;
  updateMachine(id: string, update: MachineUpdate): Promise<MachineSettings>;
  removeMachine(id: string): Promise<void>;
  /** A local URL for any port on a machine (remote ports tunnel over SSH). */
  openPort(machine: string, port: number): Promise<string>;

  autostart(): Promise<Autostart>;
  setAutostart(enabled: boolean): Promise<Autostart>;

  /** Recent jobs, newest first (see jobs.ts). */
  jobs(): Promise<Job[]>;
  job(id: string): Promise<Job>;
  /** Asks a running job to stop (202); its next event says when it did. */
  cancelJob(id: string): Promise<void>;

  preferences(): Promise<Preferences>;
  /** Saves the whole object and returns what was saved (400 on an invalid value). */
  savePreferences(preferences: Preferences): Promise<Preferences>;

  /** Streams snapshots and job events until the returned function is called. */
  subscribe(handlers: FeedHandlers): () => void;
}

export function createHttpApi(token: string | null, fetchImpl?: FetchLike): Api {
  const h = createHttp(token, fetchImpl);
  const { send, json, none } = h;

  const api: Api = {
    ...createPortlessHttp(h),
    ...createDekitHttp(h),
    ...createToolsHttp(h),
    ...createPolishHttp(h),
    info: () => json<Info>("GET", "/api/info"),
    snapshot: () => json<Snapshot>("GET", "/api/snapshot"),
    act: (target, verb) => none("POST", "/api/actions", { target, verb }),
    runnerUp: (machine, runner) => none("POST", "/api/runners/up", { machine, runner }),
    excerpt: (machine, runner, task) =>
      json<Excerpt>("GET", `/api/excerpt?${new URLSearchParams({ machine, runner, task })}`),
    output: (machine, runner, task, signal) =>
      json<TaskOutput>("GET", `/api/output?${new URLSearchParams({ machine, runner, task })}`, undefined, signal),
    open: (machine, urls) => none("POST", "/api/open", { machine, urls }),
    reveal: (machine, path) => none("POST", "/api/reveal", { machine, path }),
    settings: () => json<Settings>("GET", "/api/settings"),
    saveSettings: (settings) => json<Settings>("PUT", "/api/settings", settings),
    async pickFolder() {
      const res = await send("POST", "/api/folders/pick", {});
      if (res.status === 204) return { kind: "cancelled" };
      if (res.status === 501) return { kind: "unsupported" };
      if (!res.ok) throw await h.fail(res);
      const body = (await res.json()) as { path?: string };
      return body.path ? { kind: "picked", path: body.path } : { kind: "cancelled" };
    },
    setupCheck: () => json<SetupCheck>("GET", "/api/setup/check"),
    setupScan: (folder, overrides) => json<Proposal>("POST", "/api/setup/scan", { folder, overrides }),
    setupApply: (folder, digest, overrides) => json<ApplyResult>("POST", "/api/setup/apply", { folder, digest, overrides }),
    machines: () => json<MachineSettings[]>("GET", "/api/machines"),
    machineCandidates: () => json<MachineCandidate[]>("GET", "/api/machines/candidates"),
    addMachine: (machine, signal) => json<MachineSettings>("POST", "/api/machines", machine, signal),
    updateMachine: (id, update) => json<MachineSettings>("PUT", `/api/machines/${seg(id)}`, update),
    removeMachine: (id) => none("DELETE", `/api/machines/${seg(id)}`),
    openPort: async (machine, port) => (await json<{ url: string }>("POST", "/api/ports/open", { machine, port })).url,
    autostart: () => json<Autostart>("GET", "/api/autostart"),
    setAutostart: (enabled) => json<Autostart>("PUT", "/api/autostart", { enabled }),
    jobs: () => json<Job[]>("GET", "/api/jobs"),
    job: (id) => json<Job>("GET", `/api/jobs/${seg(id)}`),
    cancelJob: (id) => none("POST", `/api/jobs/${seg(id)}/cancel`, {}),
    preferences: () => json<Preferences>("GET", "/api/preferences"),
    savePreferences: (preferences) => json<Preferences>("PUT", "/api/preferences", preferences),
    subscribe: (handlers) =>
      connectFeed({
        url: eventsUrl(token),
        fetchSnapshot: () => api.snapshot(),
        ...handlers,
      }),
  };
  return api;
}

/** EventSource cannot set headers, so the stream takes the token as a query parameter. */
export function eventsUrl(token: string | null): string {
  return token ? `/api/events?${new URLSearchParams({ token })}` : "/api/events";
}
