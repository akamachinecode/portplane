import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Api } from "../../api/client";
import { errorText } from "../../api/errors";
import { useJobs } from "../../api/jobs";
import type { DoctorReport, PortlessAction, PortlessStatus, RouteView } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { invalidateProblems } from "../../shell/health";

// What the Domains sections share: portless's status and the last doctor
// report, loaded once and kept for every section (and the Health view's
// problems, see problems.ts), and "intents" that let the palette, Other
// ports or a Health fix open a dialog in a section.

export type Load<T> = { status: "idle" } | { status: "loading"; value?: T } | { status: "ok"; value: T; at: number } | { status: "error"; error: string; value?: T };

interface Resource<T> {
  get(): Load<T>;
  load(api: Api): Promise<void>;
  /** A value an action returned (the routes after adding an alias). */
  put(value: T): void;
  subscribe(l: () => void): () => void;
}

function resource<T>(fetch: (api: Api) => Promise<T>): Resource<T> {
  let state: Load<T> = { status: "idle" };
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Load<T>) => {
    state = next;
    for (const l of listeners) l();
    invalidateProblems();
  };
  const last = () => ("value" in state ? state.value : undefined);
  return {
    get: () => state,
    load(api) {
      if (inflight) return inflight;
      set({ status: "loading", value: last() });
      inflight = fetch(api)
        .then(
          (value) => set({ status: "ok", value, at: Date.now() }),
          (err: unknown) => set({ status: "error", error: errorText(err), value: last() }),
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    put: (value) => set({ status: "ok", value, at: Date.now() }),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const statusResource = resource<PortlessStatus>((api) => api.portlessStatus());
export const doctorResource = resource<DoctorReport>((api) => api.portlessDoctor());
export const routesResource = resource<RouteView[]>((api) => api.portlessRoutes());

/** The latest value of a resource, whatever its state. */
export function valueOf<T>(l: Load<T>): T | undefined {
  return "value" in l ? l.value : undefined;
}

function useResource<T>(r: Resource<T>, autoload: boolean) {
  const { api } = useApp();
  const state = useSyncExternalStore(r.subscribe, r.get);
  useEffect(() => {
    if (autoload && r.get().status === "idle") void r.load(api);
  }, [api, autoload, r]);
  const reload = useCallback(() => r.load(api), [api, r]);
  return { state, reload };
}

/** portless's status, loaded on first use and shared. */
export function usePortlessStatus() {
  return useResource(statusResource, true);
}

/**
 * Loads portless's status once in the background (no doctor run), so the
 * Health view knows about a broken service from the first screen.
 */
export function usePrimePortless(enabled: boolean): void {
  const { api } = useApp();
  useEffect(() => {
    if (enabled && statusResource.get().status === "idle") void statusResource.load(api);
  }, [api, enabled]);
}

/** Every route of routes.json, loaded on first use. */
export function useRoutes() {
  return useResource(routesResource, true);
}

/** The doctor report; `autorun` runs doctor when none was loaded yet. */
export function usePortlessDoctor(autorun = false) {
  return useResource(doctorResource, autorun);
}

/**
 * Reloads the status (and the doctor report, when one is shown) when a
 * portless job finishes, so the page shows what the job changed.
 */
export function useRefreshOnJobs(onDone?: () => void) {
  const { api } = useApp();
  const { jobs } = useJobs();
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef(onDone);
  cb.current = onDone;
  useEffect(() => {
    const finished = jobs.filter((j) => j.kind.startsWith("portless.") && j.state !== "running").map((j) => j.id);
    if (seen.current === null) {
      seen.current = new Set(finished); // jobs that ended before this page opened
      return;
    }
    const fresh = finished.filter((id) => !seen.current!.has(id));
    if (!fresh.length) return;
    for (const id of fresh) seen.current.add(id);
    void statusResource.load(api);
    if (routesResource.get().status !== "idle") void routesResource.load(api);
    if (doctorResource.get().status !== "idle") void doctorResource.load(api);
    cb.current?.();
  }, [jobs, api]);
}

// ---- intents ----

export type Intent = { kind: "new-alias"; port?: number; name?: string } | { kind: "action"; action: PortlessAction } | { kind: "run-doctor" };

let intent: Intent | null = null;
const intentListeners = new Set<() => void>();

/** Asks a section to open something; the section takes it when it shows. */
export function requestIntent(next: Intent): void {
  intent = next;
  for (const l of intentListeners) l();
}

/** The pending intent of one kind, taken (cleared) by the caller. */
export function useIntent<K extends Intent["kind"]>(kind: K, take: (i: Extract<Intent, { kind: K }>) => void): void {
  const pending = useSyncExternalStore(
    (l) => {
      intentListeners.add(l);
      return () => intentListeners.delete(l);
    },
    () => intent,
  );
  const cb = useRef(take);
  cb.current = take;
  useEffect(() => {
    if (pending?.kind !== kind) return;
    intent = null;
    cb.current(pending as Extract<Intent, { kind: K }>);
  }, [pending, kind]);
}
