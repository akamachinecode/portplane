import { useEffect, useState } from "react";
import type { Api } from "./client";
import { isUnauthorized } from "./errors";
import type { Snapshot } from "./types";

// The binary pushes the whole Snapshot as `event: snapshot` on connect and on
// every change (ADR-0008: the token travels as ?token= since EventSource
// cannot set headers).

export type ConnectionStatus =
  | "connecting" // first connection, nothing received yet
  | "live"
  | "reconnecting" // the stream dropped; retrying
  | "expired"; // the token was refused: Portplane restarted, reload the page

export interface FeedHandlers {
  onSnapshot(snapshot: Snapshot): void;
  onStatus(status: ConnectionStatus): void;
}

/** The part of EventSource the feed uses, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: "snapshot", listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export interface FeedOptions extends FeedHandlers {
  url: string;
  /** GET /api/snapshot: fills the gap after a reconnect and tells a dead token from a dead server. */
  fetchSnapshot(): Promise<Snapshot>;
  createSource?: (url: string) => EventSourceLike;
}

const CLOSED = 2; // EventSource.CLOSED, spelled out so tests can run without a DOM

/** Delays between manual reconnects, once the browser has given up on its own. */
export const RETRY_DELAYS = [1000, 2000, 5000, 10000, 15000];

/** Opens the event stream and keeps it open. Returns a function that closes it for good. */
export function connectFeed(opts: FeedOptions): () => void {
  const create = opts.createSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let attempt = 0;
  let connected = false; // opened at least once
  let dropped = false; // dropped since the last successful open
  let eventsSinceOpen = 0;
  let status: ConnectionStatus | null = null;

  const setStatus = (next: ConnectionStatus) => {
    if (next === status) return;
    status = next;
    opts.onStatus(next);
  };

  function open() {
    if (disposed) return;
    const src = create(opts.url);
    source = src;

    src.addEventListener("snapshot", (ev) => {
      if (disposed || src !== source) return;
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(ev.data) as Snapshot;
      } catch {
        return;
      }
      eventsSinceOpen++;
      setStatus("live");
      opts.onSnapshot(snapshot);
    });

    src.onopen = () => {
      if (disposed || src !== source) return;
      attempt = 0;
      connected = true;
      // The browser reopens the same EventSource after a drop: count afresh.
      eventsSinceOpen = 0;
      setStatus("live");
      if (!dropped) return;
      dropped = false;
      // The server sends a snapshot on connect; this covers a server that is
      // slow to, without overwriting one that already arrived.
      opts.fetchSnapshot().then(
        (snapshot) => {
          if (!disposed && src === source && eventsSinceOpen === 0) opts.onSnapshot(snapshot);
        },
        () => {},
      );
    };

    src.onerror = () => {
      if (disposed || src !== source) return;
      dropped = true;
      setStatus(connected ? "reconnecting" : "connecting");
      if (src.readyState !== CLOSED) return; // the browser retries on its own
      // The browser gave up, which happens on an HTTP error such as a refused
      // token. Ask the plain API why before retrying by hand.
      src.close();
      source = null;
      probe();
    };
  }

  function probe() {
    opts.fetchSnapshot().then(
      (snapshot) => {
        if (disposed) return;
        opts.onSnapshot(snapshot);
        schedule();
      },
      (err: unknown) => {
        if (disposed) return;
        if (isUnauthorized(err)) {
          setStatus("expired");
          return;
        }
        schedule();
      },
    );
  }

  function schedule() {
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    attempt++;
    clearTimeout(timer);
    timer = setTimeout(open, delay);
  }

  setStatus("connecting");
  open();

  return () => {
    disposed = true;
    clearTimeout(timer);
    source?.close();
    source = null;
  };
}

/** The live snapshot and the state of the connection that feeds it. */
export function useSnapshot(api: Api): { snapshot: Snapshot | null; status: ConnectionStatus } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  useEffect(() => api.subscribe({ onSnapshot: setSnapshot, onStatus: setStatus }), [api]);
  return { snapshot, status };
}
