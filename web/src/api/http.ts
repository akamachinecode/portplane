import { ApiError } from "./errors";

// The fetch helpers every API module builds on. Each request carries the
// per-run token (ADR-0008); a non-2xx answer becomes an ApiError with the
// server's message.

export const TOKEN_HEADER = "X-Portplane-Token";

export const UNREACHABLE = "Can't reach Portplane. Is it still running?";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a module's `create<X>Http(h)` factory gets to talk to the binary. */
export interface Http {
  /** The raw response, for endpoints that answer with a status rather than a body. */
  send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
  /** Parses a JSON body; an empty body resolves to undefined. */
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** For endpoints whose body does not matter. */
  none(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<void>;
  /** Turns a failed response into an ApiError, for callers of send(). */
  fail(res: Response): Promise<ApiError>;
}

export async function errorMessage(res: Response): Promise<string> {
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

export function createHttp(token: string | null, fetchImpl: FetchLike = (i, o) => fetch(i, o)): Http {
  async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers[TOKEN_HEADER] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await fetchImpl(path, {
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
  }

  const fail = async (res: Response) => new ApiError(await errorMessage(res), res.status);

  async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await send(method, path, body, signal);
    if (!res.ok) throw await fail(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function none(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<void> {
    const res = await send(method, path, body, signal);
    if (!res.ok) throw await fail(res);
  }

  return { send, json, none, fail };
}

/** A path segment, escaped: `/api/jobs/${seg(id)}`. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
