import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { connectFeed, RETRY_DELAYS, type ConnectionStatus, type EventSourceLike } from "./events";
import type { Job } from "./jobs";
import type { Snapshot } from "./types";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners: Array<(ev: MessageEvent<string>) => void> = [];
  private jobListeners: Array<(ev: MessageEvent<string>) => void> = [];
  constructor(readonly url: string) {}
  addEventListener(type: "snapshot" | "job", listener: (ev: MessageEvent<string>) => void) {
    (type === "job" ? this.jobListeners : this.listeners).push(listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  send(snapshot: Snapshot) {
    for (const l of this.listeners) l({ data: JSON.stringify(snapshot) } as MessageEvent<string>);
  }
  sendJob(data: string) {
    for (const l of this.jobListeners) l({ data } as MessageEvent<string>);
  }
  drop(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.({} as Event);
  }
}

const snap = (version: number): Snapshot => ({ machines: [], version });

function setup(fetchSnapshot: () => Promise<Snapshot> = () => Promise.resolve(snap(0))) {
  const sources: FakeSource[] = [];
  const snapshots: number[] = [];
  const statuses: ConnectionStatus[] = [];
  const jobs: Job[] = [];
  const fetchSpy = vi.fn(fetchSnapshot);
  const stop = connectFeed({
    url: "/api/events?token=t",
    fetchSnapshot: fetchSpy,
    onSnapshot: (s) => snapshots.push(s.version),
    onStatus: (s) => statuses.push(s),
    onJob: (j) => jobs.push(j),
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
  });
  return { sources, snapshots, statuses, jobs, fetchSpy, stop, last: () => sources[sources.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connectFeed", () => {
  it("connects and passes snapshots through", () => {
    const f = setup();
    expect(f.sources[0].url).toBe("/api/events?token=t");
    expect(f.statuses).toEqual(["connecting"]);
    f.last().open();
    f.last().send(snap(1));
    f.last().send(snap(2));
    expect(f.statuses).toEqual(["connecting", "live"]);
    expect(f.snapshots).toEqual([1, 2]);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  it("shows reconnecting while the browser retries, then fetches a snapshot", async () => {
    const f = setup(() => Promise.resolve(snap(7)));
    f.last().open();
    f.last().send(snap(1));
    f.last().drop(false);
    expect(f.statuses.at(-1)).toBe("reconnecting");
    f.last().open();
    expect(f.statuses.at(-1)).toBe("live");
    await vi.runAllTimersAsync();
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
    expect(f.snapshots).toEqual([1, 7]);
    expect(f.sources).toHaveLength(1);
  });

  it("does not let the fallback overwrite a snapshot the stream already sent", async () => {
    let resolve: (s: Snapshot) => void = () => {};
    const f = setup(() => new Promise((r) => (resolve = r)));
    f.last().open();
    f.last().drop(false);
    f.last().open();
    f.last().send(snap(9));
    resolve(snap(3));
    await vi.runAllTimersAsync();
    expect(f.snapshots).toEqual([9]);
  });

  it("reconnects by hand with backoff when the browser gives up", async () => {
    const f = setup(() => Promise.reject(new ApiError("down", 0)));
    f.last().open();
    f.last().drop(true);
    expect(f.sources[0].closed).toBe(true);
    expect(f.statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] - 1);
    expect(f.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sources).toHaveLength(2);
    f.last().drop(true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]);
    expect(f.sources).toHaveLength(3);
    f.last().open();
    expect(f.statuses.at(-1)).toBe("live");
  });

  it("stops and reports expired when the token is refused", async () => {
    const f = setup(() => Promise.reject(new ApiError("forbidden", 403)));
    f.last().drop(true);
    await vi.runAllTimersAsync();
    expect(f.statuses.at(-1)).toBe("expired");
    expect(f.sources).toHaveLength(1);
  });

  it("uses the API's answer while the stream is down", async () => {
    const f = setup(() => Promise.resolve(snap(5)));
    f.last().drop(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.snapshots).toEqual([5]);
    expect(f.statuses).toEqual(["connecting"]);
  });

  it("closes and stays closed", async () => {
    const f = setup();
    f.last().open();
    f.stop();
    expect(f.sources[0].closed).toBe(true);
    f.sources[0].send(snap(1));
    f.sources[0].drop(true);
    await vi.runAllTimersAsync();
    expect(f.snapshots).toEqual([]);
    expect(f.sources).toHaveLength(1);
  });

  it("ignores malformed events", () => {
    const f = setup();
    f.last().open();
    (f.last() as unknown as { listeners: Array<(e: MessageEvent<string>) => void> }).listeners[0]({ data: "{nope" } as MessageEvent<string>);
    expect(f.snapshots).toEqual([]);
  });

  it("delivers job events", () => {
    const f = setup();
    f.last().open();
    const job: Job = {
      id: "job-1",
      kind: "install",
      title: "Install dekit",
      state: "running",
      steps: [{ name: "Download", state: "running" }],
      output: ["Fetching…"],
      startedAt: "2026-11-12T10:00:00Z",
    };
    f.last().sendJob(JSON.stringify(job));
    f.last().sendJob(JSON.stringify({ ...job, state: "succeeded", endedAt: "2026-11-12T10:00:05Z" }));
    expect(f.jobs.map((j) => j.state)).toEqual(["running", "succeeded"]);
    expect(f.jobs[0]).toEqual(job);
    expect(f.snapshots).toEqual([]);
  });

  it("ignores malformed job events and counts a job as a sign of life", () => {
    const f = setup();
    f.last().sendJob("{nope");
    f.last().sendJob(JSON.stringify({ title: "no id" }));
    expect(f.jobs).toEqual([]);
    expect(f.statuses).toEqual(["connecting"]);
    f.last().sendJob(JSON.stringify({ id: "j", kind: "x", title: "x", state: "running", steps: [], output: [], startedAt: "2026-11-12T10:00:00Z" }));
    expect(f.statuses).toEqual(["connecting", "live"]);
  });

  it("still fills the gap after a reconnect when only job events came in", async () => {
    const f = setup(() => Promise.resolve(snap(4)));
    f.last().open();
    f.last().drop(false);
    f.last().open();
    f.last().sendJob(JSON.stringify({ id: "j", kind: "x", title: "x", state: "running", steps: [], output: [], startedAt: "2026-11-12T10:00:00Z" }));
    await vi.runAllTimersAsync();
    expect(f.snapshots).toEqual([4]);
  });

  it("stops delivering job events once closed", () => {
    const f = setup();
    f.last().open();
    f.stop();
    f.sources[0].sendJob(JSON.stringify({ id: "j", kind: "x", title: "x", state: "running", steps: [], output: [], startedAt: "2026-11-12T10:00:00Z" }));
    expect(f.jobs).toEqual([]);
  });
});
