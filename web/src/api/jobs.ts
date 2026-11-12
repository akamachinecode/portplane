import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { Api } from "./client";

// Long operations (installs, the proxy service, setup writes) run on the
// binary as jobs (plan §3.4). GET /api/jobs lists the recent ones, newest
// first; the event stream sends `event: job` with the whole Job each time
// one changes. Mirror of the Go type: keep both in sync.

export type JobState = "running" | "succeeded" | "failed" | "cancelled";
export type JobStepState = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface JobStep {
  name: string;
  state: JobStepState;
}

export interface Job {
  id: string;
  kind: string;
  title: string;
  state: JobState;
  steps: JobStep[];
  /** The last lines of output, at most 500. */
  output: string[];
  error?: string;
  result?: unknown;
  /** Asks for the administrator password (plan D3). */
  privileged?: boolean;
  startedAt: string;
  endedAt?: string;
}

/** How many jobs the UI keeps; the server keeps its own recent list. */
export const MAX_JOBS = 50;

export function isJobRunning(job: Job): boolean {
  return job.state === "running";
}

function newestFirst(a: Job, b: Job): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * Which of two copies of a job to keep. Events carry no version, so a copy
 * that has finished wins over one that still runs; otherwise the newer copy
 * (the second argument) wins.
 */
function fresher(current: Job, incoming: Job): Job {
  if (current.state !== "running" && incoming.state === "running") return current;
  return incoming;
}

/** Adds or replaces one job (an `event: job`), newest first. */
export function upsertJob(list: Job[], job: Job): Job[] {
  const i = list.findIndex((j) => j.id === job.id);
  if (i >= 0) {
    const next = fresher(list[i], job);
    if (next === list[i]) return list;
    const copy = [...list];
    copy[i] = next;
    // startedAt never changes, so the order holds
    return copy;
  }
  return [...list, job].sort(newestFirst).slice(0, MAX_JOBS);
}

/**
 * Merges a fetched list (GET /api/jobs) into what the stream already sent:
 * events that arrived while the request ran are not lost.
 */
export function mergeJobs(current: Job[], fetched: Job[]): Job[] {
  const byId = new Map(current.map((j) => [j.id, j]));
  for (const j of fetched) {
    const have = byId.get(j.id);
    byId.set(j.id, have ? fresher(have, j) : j);
  }
  return [...byId.values()].sort(newestFirst).slice(0, MAX_JOBS);
}

/** The jobs the UI knows about, shared by every component that shows them. */
export interface JobsStore {
  list(): Job[];
  upsert(job: Job): void;
  merge(jobs: Job[]): void;
  subscribe(listener: () => void): () => void;
}

export function createJobsStore(): JobsStore {
  let jobs: Job[] = [];
  const listeners = new Set<() => void>();
  const set = (next: Job[]) => {
    if (next === jobs) return;
    jobs = next;
    for (const l of listeners) l();
  };
  return {
    list: () => jobs,
    upsert: (job) => set(upsertJob(jobs, job)),
    merge: (fetched) => set(mergeJobs(jobs, fetched)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const JobsContext = createContext<{ store: JobsStore; api: Api } | null>(null);

function useJobsContext() {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error("useJobs outside JobsContext");
  return ctx;
}

export interface UseJobs {
  /** Newest first. */
  jobs: Job[];
  running: Job[];
  /** POST /api/jobs/{id}/cancel; the job's next event says when it stopped. */
  cancel(id: string): Promise<void>;
}

/** The recent jobs, live. */
export function useJobs(): UseJobs {
  const { store, api } = useJobsContext();
  const jobs = useSyncExternalStore(store.subscribe, store.list);
  const cancel = useCallback((id: string) => api.cancelJob(id), [api]);
  return useMemo(() => ({ jobs, running: jobs.filter(isJobRunning), cancel }), [jobs, cancel]);
}

/** One job by id, live; undefined until the UI has heard of it. */
export function useJob(id: string | null | undefined): Job | undefined {
  const { jobs } = useJobs();
  return id ? jobs.find((j) => j.id === id) : undefined;
}
