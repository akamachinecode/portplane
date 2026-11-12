import { describe, expect, it } from "vitest";
import { createJobsStore, MAX_JOBS, mergeJobs, upsertJob, type Job } from "./jobs";

const job = (id: string, p: Partial<Job> = {}): Job => ({
  id,
  kind: "install",
  title: `Job ${id}`,
  state: "running",
  steps: [],
  output: [],
  startedAt: `2026-11-12T10:00:0${id}Z`,
  ...p,
});

describe("upsertJob", () => {
  it("adds jobs newest first and replaces by id", () => {
    let list = upsertJob([], job("1"));
    list = upsertJob(list, job("3"));
    list = upsertJob(list, job("2"));
    expect(list.map((j) => j.id)).toEqual(["3", "2", "1"]);
    list = upsertJob(list, job("2", { output: ["hello"] }));
    expect(list.map((j) => j.id)).toEqual(["3", "2", "1"]);
    expect(list[1].output).toEqual(["hello"]);
  });

  it("never lets a late running copy undo a finished job", () => {
    const done = upsertJob([], job("1", { state: "succeeded", endedAt: "2026-11-12T10:00:09Z" }));
    expect(upsertJob(done, job("1"))).toBe(done);
  });

  it("keeps at most MAX_JOBS", () => {
    let list: Job[] = [];
    for (let i = 0; i < MAX_JOBS + 5; i++) list = upsertJob(list, job(String(i), { startedAt: new Date(Date.UTC(2026, 10, 12, 10, 0, i)).toISOString() }));
    expect(list).toHaveLength(MAX_JOBS);
    expect(list[0].id).toBe(String(MAX_JOBS + 4));
  });
});

describe("mergeJobs", () => {
  it("keeps events that arrived while the list was fetched", () => {
    const streamed = [job("3"), job("2", { state: "failed", error: "boom" })];
    const fetched = [job("2"), job("1", { state: "succeeded" })];
    const merged = mergeJobs(streamed, fetched);
    expect(merged.map((j) => [j.id, j.state])).toEqual([
      ["3", "running"],
      ["2", "failed"],
      ["1", "succeeded"],
    ]);
  });
});

describe("createJobsStore", () => {
  it("notifies subscribers only when something changed", () => {
    const store = createJobsStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.upsert(job("1", { state: "succeeded" }));
    store.upsert(job("1")); // a stale running copy: no change
    store.merge([job("2")]);
    off();
    store.upsert(job("3"));
    expect(calls).toBe(2);
    expect(store.list().map((j) => j.id)).toEqual(["3", "2", "1"]);
  });
});
