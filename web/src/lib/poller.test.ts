import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller, defaultBackoff } from "./poller";

/** A request the test resolves or rejects by hand. */
function controlled() {
  const calls: { signal: AbortSignal; resolve(): void; reject(e: unknown): void }[] = [];
  const run = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  return { calls, run };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("createPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks at once, then a second after each answer, one request at a time", async () => {
    const { calls, run } = controlled();
    const p = createPoller({ run, interval: 1000 });
    expect(calls).toHaveLength(0);
    p.setActive(true);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000); // a slow answer: no second request meanwhile
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    p.dispose();
  });

  it("stops while inactive, aborting the request in flight, and asks again when active", async () => {
    const { calls, run } = controlled();
    const p = createPoller({ run, interval: 1000 });
    p.setActive(true);
    p.setActive(false);
    expect(calls[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    p.setActive(true);
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await settle();
    p.setActive(false); // between requests: the timer goes
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    p.dispose();
  });

  it("backs off after failures and is back to every second after a success", async () => {
    const { calls, run } = controlled();
    const p = createPoller({ run, interval: 1000, backoff: (n) => n * 3000 });
    p.setActive(true);
    calls[0].reject(new Error("offline"));
    await settle();
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    calls[1].reject(new Error("offline"));
    await settle();
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(3);
    calls[2].resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(4);
    p.dispose();
  });

  it("asks now on a retry, but never on top of a request in flight", async () => {
    const { calls, run } = controlled();
    const p = createPoller({ run, interval: 1000, backoff: () => 60_000 });
    p.setActive(true);
    p.now();
    expect(calls).toHaveLength(1);
    calls[0].reject(new Error("offline"));
    await settle();
    p.now();
    expect(calls).toHaveLength(2);
    p.dispose();
    expect(calls[1].signal.aborted).toBe(true);
    p.setActive(true); // disposed for good
    p.now();
    expect(calls).toHaveLength(2);
  });

  it("backs off to every 10 seconds by default", () => {
    expect([1, 2, 3, 4, 5, 50].map(defaultBackoff)).toEqual([2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });
});
