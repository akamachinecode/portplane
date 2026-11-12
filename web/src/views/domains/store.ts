import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Api } from "../../api/client";
import { errorText } from "../../api/errors";
import { useJobs } from "../../api/jobs";
import type { Certificates, DoctorReport, PortlessAction, PortlessStatus, RouteView } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { useMachineScope } from "../../components/MachineScope";
import { LOCAL_MACHINE } from "../../api/machine";
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

export interface MachineResources {
  status: Resource<PortlessStatus>;
  doctor: Resource<DoctorReport>;
  routes: Resource<RouteView[]>;
  certificates: Resource<Certificates>;
}

// One set per machine (ADR-0026): this computer's feeds Health; another
// machine's shows when Domains is scoped to it.
const byMachine = new Map<string, MachineResources>();

/** A machine's portless resources (Health reads every machine's). */
export function resourcesOf(machine: string): MachineResources {
  let r = byMachine.get(machine);
  if (!r) {
    r = {
      status: resource<PortlessStatus>((api) => api.portlessStatus()),
      doctor: resource<DoctorReport>((api) => api.portlessDoctor()),
      routes: resource<RouteView[]>((api) => api.portlessRoutes()),
      certificates: resource<Certificates>((api) => api.portlessCertificates()),
    };
    byMachine.set(machine, r);
  }
  return r;
}

/** This computer's resources (Health reads them). */
export const statusResource = resourcesOf(LOCAL_MACHINE).status;
export const doctorResource = resourcesOf(LOCAL_MACHINE).doctor;
export const routesResource = resourcesOf(LOCAL_MACHINE).routes;
export const certificatesResource = resourcesOf(LOCAL_MACHINE).certificates;

/** The resources of the machine the surrounding scope acts on. */
export function useMachineResources(): MachineResources {
  return resourcesOf(useMachineScope().id);
}

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
  return { state, reload, put: r.put };
}

/** portless's status, loaded on first use and shared (per machine). */
export function usePortlessStatus() {
  return useResource(useMachineResources().status, true);
}

/**
 * Loads portless's status and certificates once in the background (no
 * doctor run), so the Health view knows about a broken service or an
 * untrusted certificate from the first screen.
 */
export function usePrimePortless(enabled: boolean): void {
  const { api } = useApp();
  useEffect(() => {
    if (enabled) primePortless(api, LOCAL_MACHINE);
  }, [api, enabled]);
}

/**
 * Loads a machine's portless status and certificates once (again with
 * force), for Health; `api` is that machine's (api.forMachine).
 */
export function primePortless(api: Api, machine: string, force = false): void {
  const r = resourcesOf(machine);
  if (force || r.status.get().status === "idle") void r.status.load(api);
  if (force || r.certificates.get().status === "idle") void r.certificates.load(api);
}

/** Every route of routes.json, loaded on first use. */
export function useRoutes() {
  return useResource(useMachineResources().routes, true);
}

/** The doctor report; `autorun` runs doctor when none was loaded yet. */
export function usePortlessDoctor(autorun = false) {
  return useResource(useMachineResources().doctor, autorun);
}

/**
 * Reloads the status (and the doctor report, when one is shown) when a
 * portless job finishes, so the page shows what the job changed.
 */
export function useRefreshOnJobs(onDone?: () => void) {
  const { api } = useApp();
  const { id: machine } = useMachineScope();
  const { status: statusR, routes: routesR, doctor: doctorR, certificates: certificatesR } = resourcesOf(machine);
  const { jobs } = useJobs();
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef(onDone);
  cb.current = onDone;
  useEffect(() => {
    const finished = jobs.filter((j) => j.kind.startsWith("portless.") && j.state !== "running" && (j.machine ?? LOCAL_MACHINE) === machine).map((j) => j.id);
    if (seen.current === null) {
      seen.current = new Set(finished); // jobs that ended before this page opened
      return;
    }
    const fresh = finished.filter((id) => !seen.current!.has(id));
    if (!fresh.length) return;
    for (const id of fresh) seen.current.add(id);
    void statusR.load(api);
    if (certificatesR.get().status !== "idle") void certificatesR.load(api);
    if (routesR.get().status !== "idle") void routesR.load(api);
    if (doctorR.get().status !== "idle") void doctorR.load(api);
    cb.current?.();
  }, [jobs, api, machine, statusR, routesR, doctorR, certificatesR]);
}

// ---- intents ----

/** What to open, on which machine (this computer unless it says another). */
export type Intent = ({ kind: "new-alias"; port?: number; name?: string } | { kind: "action"; action: PortlessAction } | { kind: "run-doctor" }) & {
  machine?: string;
};

let intent: Intent | null = null;
const intentListeners = new Set<() => void>();

/** Asks a section to open something; the section takes it when it shows. */
export function requestIntent(next: Intent): void {
  intent = next;
  for (const l of intentListeners) l();
}

/**
 * The pending intent of one kind, taken (cleared) by the caller. Only a
 * section scoped to the intent's machine takes it, so one still showing
 * another machine leaves it for the view the navigation brings up.
 */
export function useIntent<K extends Intent["kind"]>(kind: K, take: (i: Extract<Intent, { kind: K }>) => void): void {
  const { id: machine } = useMachineScope();
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
    if (pending?.kind !== kind || (pending.machine ?? LOCAL_MACHINE) !== machine) return;
    intent = null;
    cb.current(pending as Extract<Intent, { kind: K }>);
  }, [pending, kind, machine]);
}
