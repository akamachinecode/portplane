import { isAlive } from "../../lib/apps";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Api } from "../../api/client";
import { errorText, isAbort } from "../../api/errors";
import type { App, MachineSnapshot, TaskOutput } from "../../api/types";
import { actOnApp, appKey, runnerKey, startRunner } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { hasText, parseAnsi, plainLines } from "../../lib/ansi";
import { copyText } from "../../lib/clipboard";
import { shellQuote } from "../../lib/format";
import { isMac } from "../../lib/keyboard";
import { findMatches, isFindShortcut, matchLabel, stepMatch } from "../../lib/outputSearch";
import { createPoller, type Poller } from "../../lib/poller";
import type { DetailTabProps } from "../AppDetail";
import { OutputLines } from "./OutputLines";
import "./OutputTab.css";

/** How often the panel asks for the screen while it is open (ADR-0021). */
const INTERVAL = 1000;

/** The command that attaches a terminal to the app, when the server has not said. */
export function attachCommand(app: Pick<App, "runner" | "task">): string {
  return `dekit -C ${shellQuote(app.runner)} attach ${shellQuote(app.task)}`;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

interface Poll {
  output: TaskOutput | null;
  error: string | null;
}

const sameOutput = (a: TaskOutput | null, b: TaskOutput) =>
  !!a && a.screen === b.screen && !!a.truncated === !!b.truncated && !!a.runnerDown === !!b.runnerDown && a.command === b.command;

/** Asks for the screen once a second while active; a failure keeps the last screen and backs off. */
function useOutputPoll(api: Api, machine: string, app: App, active: boolean) {
  const [poll, setPoll] = useState<Poll>({ output: null, error: null });
  const poller = useRef<Poller | null>(null);
  const lastOk = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    setPoll({ output: null, error: null });
    lastOk.current = null;
    const p = createPoller({
      interval: INTERVAL,
      run: async (signal) => {
        try {
          const out = await api.output(machine, app.runner, app.task, signal);
          if (signal.aborted) return;
          lastOk.current = Date.now();
          setPoll((s) => (s.error === null && sameOutput(s.output, out) ? s : { output: sameOutput(s.output, out) ? s.output : out, error: null }));
        } catch (err) {
          if (!signal.aborted && !isAbort(err)) setPoll((s) => ({ ...s, error: errorText(err) }));
          throw err;
        }
      },
    });
    poller.current = p;
    p.setActive(activeRef.current);
    return () => p.dispose();
  }, [api, machine, app.runner, app.task]);

  useEffect(() => {
    poller.current?.setActive(active);
  }, [active]);

  return { ...poll, lastOk: lastOk.current, retry: () => poller.current?.now() };
}

/** The app's live output (plan D4, ADR-0021): its terminal screen, refreshed while this tab is open. */
export function OutputTab({ ms, app }: DetailTabProps) {
  const machine = ms.machine;
  if (!machine.local && machine.status !== "online") {
    return (
      <div className="output-tab output-tab-state">
        <EmptyState icon="machine" title={`${machine.name} is offline`}>
          The output shows again once Portplane reconnects to it.
        </EmptyState>
      </div>
    );
  }
  if (!ms.tools.dekit) {
    return (
      <div className="output-tab output-tab-state">
        <EmptyState icon="terminal" title="dekit isn't installed">
          {machine.local ? "This computer" : machine.name} has no dekit, which runs the apps and keeps their output.
        </EmptyState>
      </div>
    );
  }
  return <OutputPanel key={`${machine.id}|${app.id}`} ms={ms} app={app} />;
}

function OutputPanel({ ms, app }: DetailTabProps) {
  const ctx = useApp();
  const machine = ms.machine;
  const mac = isMac(ctx.info?.os);
  const visible = usePageVisible();
  const [paused, setPaused] = useState(false);
  const { output, error, lastOk, retry } = useOutputPoll(ctx.api, machine.id, app, visible && !paused);

  const lines = useMemo(() => parseAnsi(output?.screen ?? ""), [output?.screen]);
  const plain = useMemo(() => plainLines(lines), [lines]);
  const blank = !hasText(plain);
  const blankRef = useRef(blank);
  blankRef.current = blank;
  const command = output?.command || attachCommand(app);

  // search
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (findOpen ? findMatches(plain, query) : []), [findOpen, plain, query]);
  const shown = matches.length === 0 ? -1 : Math.min(Math.max(current, 0), matches.length - 1);

  // follow the end unless the user scrolled up
  const scroller = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  const setFollowing = (on: boolean) => {
    followRef.current = on;
    setFollow(on);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [output?.screen, blank]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atEnd !== followRef.current) setFollowing(atEnd);
  };
  const jumpToEnd = () => {
    setFollowing(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // The current match comes into view when it changes, and stays there while the screen moves.
  const screenKey = findOpen ? output?.screen : undefined;
  useEffect(() => {
    if (shown < 0) return;
    scroller.current?.querySelector(`[data-match="${shown}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shown, query, screenKey]);

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  const closeFind = () => {
    setFindOpen(false);
    setCurrent(-1);
    scroller.current?.focus();
  };

  // Ctrl/⌘F finds in the output while this tab is open (the drawer is modal).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !isFindShortcut(e, mac)) return;
      e.preventDefault(); // the page's own find would search the whole app
      if (!blankRef.current) openFind();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac]);

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setCurrent(stepMatch(shown, matches.length, e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      e.preventDefault(); // close the search, not the drawer
      e.stopPropagation();
      closeFind();
    }
  };

  const copyAll = () =>
    copyText(plain.join("\n").trimEnd()).then(
      () => ctx.toast.info("Copied the output"),
      (err: unknown) => ctx.toast.error(errorText(err)),
    );
  const copyAttach = () =>
    copyText(command).then(
      () => ctx.toast.info(machine.local ? "Copied the command: paste it in a terminal to type into the app" : `Copied the command: run it on ${machine.name} to type into the app`),
      (err: unknown) => ctx.toast.error(errorText(err)),
    );

  if (!output && error) {
    return (
      <div className="output-tab output-tab-state">
        <ErrorState title="Couldn't load the output" message={error} onRetry={retry} />
      </div>
    );
  }
  if (!output) {
    return (
      <div className="output-tab output-tab-state">
        <LoadingState label="Loading the output…" />
      </div>
    );
  }

  // "Live" only while the app runs: a stopped app's output is its last screen.
  const status = paused ? "paused" : error ? "retrying" : isAlive(app.state) ? "live" : "stopped";
  const since = lastOk ? new Date(lastOk).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : null;

  return (
    <div className="output-tab">
      <div className="out-bar">
        <span className={`out-status out-status-${status}`} role="status">
          {status === "retrying" ? <Spinner size={12} /> : <span className="out-dot" aria-hidden="true" />}
          {status === "live" ? "Live" : status === "paused" ? "Paused" : status === "stopped" ? "Last output" : "Reconnecting…"}
        </span>
        <span className="out-bar-spacer" />
        <IconButton icon="search" label={`Find in the output (${mac ? "⌘F" : "Ctrl F"})`} onClick={openFind} disabled={blank} />
        <button type="button" className="btn btn-sm out-pause" onClick={() => setPaused((p) => !p)} title={paused ? "Refresh every second again" : "Stop refreshing, to read without the screen moving"}>
          {paused ? <Icon name="play" size={13} /> : <PauseGlyph />}
          {paused ? "Resume" : "Pause"}
        </button>
        <IconButton icon="copy" label="Copy all the output" onClick={() => void copyAll()} disabled={blank} />
        <IconButton icon="terminal" label={`Open in a terminal: copies ${command}`} onClick={() => void copyAttach()} />
      </div>

      {findOpen && (
        <div className="out-find" role="search">
          <Icon name="search" size={14} className="out-find-icon" />
          <input
            ref={findInput}
            className="out-find-input"
            type="search"
            aria-label="Find in the output"
            placeholder="Find in the output"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(0);
            }}
            onKeyDown={onFindKey}
          />
          <span className="out-find-count" aria-live="polite">
            {matchLabel(shown, matches.length, query)}
          </span>
          <button type="button" className="icon-btn" aria-label="Previous match (Shift Enter)" title="Previous match (Shift Enter)" disabled={!matches.length} onClick={() => setCurrent(stepMatch(shown, matches.length, -1))}>
            <Icon name="chevronDown" className="out-flip" />
          </button>
          <button type="button" className="icon-btn" aria-label="Next match (Enter)" title="Next match (Enter)" disabled={!matches.length} onClick={() => setCurrent(stepMatch(shown, matches.length, 1))}>
            <Icon name="chevronDown" />
          </button>
          <IconButton icon="close" label="Close find (Esc)" onClick={closeFind} />
        </div>
      )}

      {error && (
        <p className="out-note out-note-warn" role="alert">
          <Icon name="warning" size={14} />
          <span>
            Not updating: {error}.{since ? ` Showing the screen from ${since}.` : ""}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => (paused ? setPaused(false) : retry())}>
            Try again
          </button>
        </p>
      )}
      {output.truncated && !error && <p className="out-note">Showing the end: the whole screen is too large to send every second.</p>}

      {output.runnerDown ? (
        <RunnerDown ms={ms} app={app} />
      ) : blank ? (
        <NoOutput ms={ms} app={app} />
      ) : (
        <div className="out-box">
          <div className="out-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} role="region" aria-label={`Output of ${app.label}`}>
            <OutputLines lines={lines} matches={matches} current={shown} />
          </div>
          {!follow && (
            <button type="button" className="btn btn-sm out-jump" onClick={jumpToEnd}>
              <Icon name="chevronDown" size={14} />
              Jump to the end
            </button>
          )}
        </div>
      )}
      {!output.runnerDown && !blank && <p className="out-foot">This is the app's current screen, as dekit keeps it. For older lines, open it in a terminal.</p>}
    </div>
  );
}

function PauseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function canAct(ms: MachineSnapshot): boolean {
  return !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online");
}

function RunnerDown({ ms, app }: DetailTabProps) {
  const ctx = useApp();
  const key = runnerKey(ms.machine.id, app.runner);
  return (
    <EmptyState
      icon="terminal"
      title="The project isn't running"
      action={
        canAct(ms) && (
          <button type="button" className="btn" aria-busy={ctx.pending.has(key) || undefined} onClick={() => void startRunner(ctx, ms.machine.id, app.runner)}>
            {ctx.pending.has(key) ? <Spinner /> : <Icon name="play" size={14} />}
            Start the project
          </button>
        )
      }
    >
      Its dekit runner is stopped, so none of its apps has output. Starting it starts its saved and autostart apps.
    </EmptyState>
  );
}

function NoOutput({ ms, app }: DetailTabProps) {
  const ctx = useApp();
  const key = appKey(ms.machine.id, app) + "start";
  if (app.state === "off") {
    return (
      <EmptyState
        icon="terminal"
        title="No output yet"
        action={
          canAct(ms) && (
            <button type="button" className="btn" aria-busy={ctx.pending.has(key) || undefined} onClick={() => void actOnApp(ctx, ms.machine.id, app, "start")}>
              {ctx.pending.has(key) ? <Spinner /> : <Icon name="play" size={14} />}
              Start {app.label}
            </button>
          )
        }
      >
        {app.label} hasn't run since its project started. What it prints shows here, live.
      </EmptyState>
    );
  }
  if (app.state === "failed" || app.state === "done") {
    return (
      <EmptyState icon="terminal" title="It printed nothing">
        {app.label} stopped without printing anything.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon="terminal" title="Nothing printed yet">
      {app.state === "starting" && app.detail ? `${app.label} is ${app.detail}. ` : `${app.label} hasn't printed anything yet. `}
      This updates every second.
    </EmptyState>
  );
}
