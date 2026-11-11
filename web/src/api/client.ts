import { ApiError } from "./errors";
import { connectFeed, type FeedHandlers } from "./events";
import type { Excerpt, Info, Settings, Snapshot, Target, Verb } from "./types";

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
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
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
      });
    } catch {
      throw new ApiError(UNREACHABLE, 0);
    }
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body);
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
      const res = await send("POST", "/api/folders/pick");
      if (res.status === 204) return { kind: "cancelled" };
      if (res.status === 501) return { kind: "unsupported" };
      if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
      const body = (await res.json()) as { path?: string };
      return body.path ? { kind: "picked", path: body.path } : { kind: "cancelled" };
    },
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
