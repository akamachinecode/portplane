import { ApiError } from "./errors";
import { connectFeed, type FeedHandlers } from "./events";
import type {
  ApplyResult,
  Autostart,
  Excerpt,
  Info,
  MachineCandidate,
  MachineSettings,
  MachineUpdate,
  NewMachine,
  Proposal,
  Settings,
  SetupCheck,
  SetupOverrides,
  Snapshot,
  Target,
  Verb,
} from "./types";

export { ApiError } from "./errors";

// Every request carries the per-run token (ADR-0008); errors become ApiError.
export const TOKEN_HEADER = "X-Portplane-Token";

export type PickResult = { kind: "picked"; path: string } | { kind: "cancelled" } | { kind: "unsupported" };

/** Everything the UI needs from the binary. The mock in mock.ts implements the same interface. */
export interface Api {
  info(): Promise<Info>;
  snapshot(): Promise<Snapshot>;
  act(target: Target, verb: Verb): Promise<void>;
  runnerUp(machine: string, runner: string): Promise<void>;
  excerpt(machine: string, runner: string, task: string): Promise<Excerpt>;
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

  /** Streams snapshots until the returned function is called. */
  subscribe(handlers: FeedHandlers): () => void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const UNREACHABLE = "Can't reach Portplane. Is it still running?";

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") return body.error;
    } catch {
      // not JSON: fall through to the raw text
    }
    return text.trim().slice(0, 300);
  }
  return `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`;
}

export function createHttpApi(token: string | null, fetchImpl: FetchLike = (i, o) => fetch(i, o)): Api {
  async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers[TOKEN_HEADER] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // the caller cancelled: not a dead server
      throw new ApiError(UNREACHABLE, 0);
    }
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await send(method, path, body, signal);
    if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function none(method: string, path: string, body?: unknown): Promise<void> {
    const res = await send(method, path, body);
    if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  }

  const api: Api = {
    info: () => json<Info>("GET", "/api/info"),
    snapshot: () => json<Snapshot>("GET", "/api/snapshot"),
    act: (target, verb) => none("POST", "/api/actions", { target, verb }),
    runnerUp: (machine, runner) => none("POST", "/api/runners/up", { machine, runner }),
    excerpt: (machine, runner, task) =>
      json<Excerpt>("GET", `/api/excerpt?${new URLSearchParams({ machine, runner, task })}`),
    open: (machine, urls) => none("POST", "/api/open", { machine, urls }),
    reveal: (machine, path) => none("POST", "/api/reveal", { machine, path }),
    settings: () => json<Settings>("GET", "/api/settings"),
    saveSettings: (settings) => json<Settings>("PUT", "/api/settings", settings),
    async pickFolder() {
      const res = await send("POST", "/api/folders/pick", {});
      if (res.status === 204) return { kind: "cancelled" };
      if (res.status === 501) return { kind: "unsupported" };
      if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
      const body = (await res.json()) as { path?: string };
      return body.path ? { kind: "picked", path: body.path } : { kind: "cancelled" };
    },
    setupCheck: () => json<SetupCheck>("GET", "/api/setup/check"),
    setupScan: (folder, overrides) => json<Proposal>("POST", "/api/setup/scan", { folder, overrides }),
    setupApply: (folder, digest, overrides) => json<ApplyResult>("POST", "/api/setup/apply", { folder, digest, overrides }),
    machines: () => json<MachineSettings[]>("GET", "/api/machines"),
    machineCandidates: () => json<MachineCandidate[]>("GET", "/api/machines/candidates"),
    addMachine: (machine, signal) => json<MachineSettings>("POST", "/api/machines", machine, signal),
    updateMachine: (id, update) => json<MachineSettings>("PUT", `/api/machines/${encodeURIComponent(id)}`, update),
    removeMachine: (id) => none("DELETE", `/api/machines/${encodeURIComponent(id)}`),
    openPort: async (machine, port) => (await json<{ url: string }>("POST", "/api/ports/open", { machine, port })).url,
    autostart: () => json<Autostart>("GET", "/api/autostart"),
    setAutostart: (enabled) => json<Autostart>("PUT", "/api/autostart", { enabled }),
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
