// A polling loop for views that refresh while they are visible (the Output
// panel asks for a task's screen once a second). One request at a time, the
// next one a delay after the last answer; pausing aborts the request in
// flight so nothing changes on screen afterwards. Failures back off.

export interface PollerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PollerOptions {
  /** One request. Resolve on success; reject on failure. */
  run(signal: AbortSignal): Promise<void>;
  /** The delay after a success, in ms. */
  interval: number;
  /** The delay after `failures` failures in a row (1, 2, …). */
  backoff?(failures: number): number;
  timers?: PollerTimers;
}

export interface Poller {
  /** Polls while active: at once when it becomes active, then on a timer. */
  setActive(active: boolean): void;
  /** Asks now (a retry button), if active and nothing is in flight. */
  now(): void;
  /** Stops for good and aborts the request in flight. */
  dispose(): void;
}

/** 2 s, 4 s, 8 s, then every 10 s. */
export function defaultBackoff(failures: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.min(failures, 4));
}

const browserTimers: PollerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createPoller(opts: PollerOptions): Poller {
  const timers = opts.timers ?? browserTimers;
  const backoff = opts.backoff ?? defaultBackoff;
  let active = false;
  let disposed = false;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  let failures = 0;

  const clearTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  const tick = () => {
    timer = null;
    if (!active || disposed || inFlight) return;
    const ctl = new AbortController();
    inFlight = ctl;
    opts.run(ctl.signal).then(
      () => {
        failures = 0;
      },
      () => {
        if (!ctl.signal.aborted) failures++;
      },
    ).finally(() => {
      if (inFlight !== ctl) return; // aborted and superseded
      inFlight = null;
      if (active && !disposed) timer = timers.set(tick, failures ? backoff(failures) : opts.interval);
    });
  };

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (active) {
        tick();
        return;
      }
      clearTimer();
      inFlight?.abort();
      inFlight = null;
    },
    now() {
      if (!active || disposed || inFlight) return;
      clearTimer();
      tick();
    },
    dispose() {
      disposed = true;
      active = false;
      clearTimer();
      inFlight?.abort();
      inFlight = null;
    },
  };
}
