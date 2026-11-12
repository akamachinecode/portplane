import { ApiError } from "./errors";
import type { Job } from "./jobs";

// Fake jobs for `?mock` and tests: steps run one after another, print a few
// lines each, and every change goes to the listeners like `event: job`.

export interface MockJobStep {
  name: string;
  /** How long the step runs. */
  ms: number;
  output?: string[];
}

export interface MockJobSpec {
  kind: string;
  title: string;
  steps: MockJobStep[];
  privileged?: boolean;
  /** The step that fails, by index; the job then fails with `error`. */
  failAt?: number;
  error?: string;
  result?: unknown;
  /** The machine it runs on; absent for this computer. */
  machine?: string;
}

export interface MockJobs {
  /** Newest first. */
  list(): Job[];
  get(id: string): Job;
  start(spec: MockJobSpec): Job;
  cancel(id: string): void;
  onChange(listener: (job: Job) => void): () => void;
}

const MAX_OUTPUT = 500;

export function createMockJobs(): MockJobs {
  const jobs = new Map<string, Job>();
  const listeners = new Set<(job: Job) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let next = 1;

  const emit = (job: Job) => {
    jobs.set(job.id, job);
    for (const l of listeners) l(structuredClone(job));
  };
  const finish = (job: Job, patch: Partial<Job>) => {
    clearTimeout(timers.get(job.id));
    timers.delete(job.id);
    emit({ ...job, ...patch, endedAt: new Date().toISOString() });
  };
  const notFound = (id: string) => new ApiError(`no job "${id}"`, 404);

  function run(id: string, spec: MockJobSpec, step: number) {
    const job = jobs.get(id);
    if (!job || job.state !== "running") return;
    if (step >= spec.steps.length) {
      finish(job, { state: "succeeded", result: spec.result });
      return;
    }
    const s = spec.steps[step];
    const lines = s.output ?? [];
    const steps = job.steps.map((x, i) => (i === step ? { ...x, state: "running" as const } : x));
    emit({ ...job, steps });
    // Print the step's lines spread over its duration, then end it.
    const tick = Math.max(40, Math.floor(s.ms / (lines.length + 1)));
    let printed = 0;
    const print = () => {
      const cur = jobs.get(id);
      if (!cur || cur.state !== "running") return;
      if (printed < lines.length) {
        emit({ ...cur, output: [...cur.output, lines[printed++]].slice(-MAX_OUTPUT) });
        timers.set(id, setTimeout(print, tick));
        return;
      }
      if (spec.failAt === step) {
        const failed = cur.steps.map((x, i) => (i === step ? { ...x, state: "failed" as const } : i > step ? { ...x, state: "skipped" as const } : x));
        finish(cur, { state: "failed", steps: failed, error: spec.error ?? `${s.name} failed` });
        return;
      }
      emit({ ...cur, steps: cur.steps.map((x, i) => (i === step ? { ...x, state: "succeeded" as const } : x)) });
      timers.set(id, setTimeout(() => run(id, spec, step + 1), 60));
    };
    timers.set(id, setTimeout(print, tick));
  }

  return {
    list: () => [...jobs.values()].reverse().map((j) => structuredClone(j)),
    get(id) {
      const job = jobs.get(id);
      if (!job) throw notFound(id);
      return structuredClone(job);
    },
    start(spec) {
      const job: Job = {
        id: spec.machine ? `${spec.machine}:job-${next++}` : `job-${next++}`,
        machine: spec.machine,
        kind: spec.kind,
        title: spec.title,
        state: "running",
        steps: spec.steps.map((s) => ({ name: s.name, state: "pending" })),
        output: [],
        privileged: spec.privileged || undefined,
        startedAt: new Date().toISOString(),
      };
      emit(job);
      timers.set(job.id, setTimeout(() => run(job.id, spec, 0), 80));
      return structuredClone(job);
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) throw notFound(id);
      if (job.state !== "running") return;
      const steps = job.steps.map((s) => (s.state === "running" ? { ...s, state: "failed" as const } : s.state === "pending" ? { ...s, state: "skipped" as const } : s));
      finish(job, { state: "cancelled", steps, output: [...job.output, "Cancelled."].slice(-MAX_OUTPUT) });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What "Run a demo job" starts in mock mode: an install with a checksum check. */
export function demoJob(fail = false): MockJobSpec {
  return {
    kind: "demo",
    title: fail ? "Install demo-tool (fails)" : "Install demo-tool",
    steps: [
      {
        name: "Download",
        ms: 1400,
        output: [
          "Fetching https://example.com/demo-tool/v1.2.3/demo-tool-linux-x64.tar.gz",
          "  1.2 MB / 4.8 MB",
          "  3.1 MB / 4.8 MB",
          "  4.8 MB / 4.8 MB",
          "Saved to ~/.cache/portplane/downloads/demo-tool-linux-x64.tar.gz",
        ],
      },
      {
        name: "Verify checksum",
        ms: 700,
        output: fail
          ? ["expected sha256 9f2c…41ab", "     got sha256 07d1…e3c9"]
          : ["sha256 9f2c…41ab matches SHA256SUMS"],
      },
      { name: "Install", ms: 900, output: ["Installing to ~/.local/bin/demo-tool", "chmod 755 ~/.local/bin/demo-tool"] },
      { name: "Check", ms: 500, output: ["$ demo-tool --version", "demo-tool 1.2.3"] },
    ],
    failAt: fail ? 1 : undefined,
    error: fail ? "The download doesn't match its published checksum, so it wasn't installed." : undefined,
    result: fail ? undefined : { version: "1.2.3" },
  };
}
