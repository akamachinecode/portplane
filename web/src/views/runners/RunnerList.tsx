import { useState } from "react";
import type { RunnerAction, RunnerInfo } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import { useApp } from "../../components/AppContext";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { Menu, type MenuItem } from "../../components/Menu";
import { StateDot } from "../../components/StateDot";
import { useNow } from "../../hooks/useNow";
import { RUNNER_STATE_LABEL, runnerTone, sinceText } from "../../lib/dekit/why";
import { shortenPath } from "../../lib/format";
import { href, navigate } from "../../lib/router";
import { useMachineScope } from "../../components/MachineScope";
import { setRunnerJob, useRunnerJob } from "./useRunners";

/** What each runner action says before it runs (plan §4.1). */
const CONFIRM: Partial<Record<RunnerAction, { title: (name: string) => string; body: string; label: string }>> = {
  down: {
    title: (n) => `Stop ${n}?`,
    body: "Stops every task and the runner, and saves which tasks you had started: the next Start brings them back.",
    label: "Stop and save",
  },
  stop: {
    title: (n) => `Stop ${n} without saving?`,
    body: "Stops the runner and every task in it, and forgets them: its next start begins fresh from dekit.yaml.",
    label: "Stop without saving",
  },
  restart: {
    title: (n) => `Restart ${n}?`,
    body: "Reloads dekit.yaml in place. Running tasks keep running.",
    label: "Restart runner",
  },
  upgrade: {
    title: (n) => `Upgrade ${n}?`,
    body: "Switches it to the dekit binary its project selects, in place. Tasks keep running.",
    label: "Upgrade",
  },
};

function runnerName(r: RunnerInfo, remote: string | null): string {
  if (r.kind !== "host") return r.name;
  return remote ? `${remote}'s own runner` : "this computer's runner";
}

/** The job a runner's last action started, inline under its row. */
export function RunnerJob({ root }: { root: string }) {
  const { id: machine } = useMachineScope();
  const id = useRunnerJob(machine, root);
  const job = useJob(id);
  if (!id || !job) return null;
  return (
    <div className="runner-job">
      <JobCard job={job} lines={6} headingLevel={4} />
      {job.state !== "running" && (
        <button type="button" className="btn btn-sm btn-ghost runner-job-dismiss" onClick={() => setRunnerJob(machine, root, null)}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function RunnerDetails({ runner, home, since, onClose }: { runner: RunnerInfo; home: string | undefined; since: string; onClose(): void }) {
  const rows: Array<[string, string | undefined, string?]> = [
    ["State", `${RUNNER_STATE_LABEL[runner.state]}${since ? ` ${since}` : ""}`],
    ["Process", runner.pid ? `PID ${runner.pid}` : undefined],
    ["dekit", runner.version ? `v${runner.version}` : undefined],
    ["Binary", runner.binary ? shortenPath(runner.binary, home) : undefined, runner.binary],
    ["Selected binary", runner.selectedBinary && runner.selectedBinary !== runner.binary ? shortenPath(runner.selectedBinary, home) : undefined, runner.selectedBinary],
    ["Config", runner.config ? shortenPath(runner.config, home) : undefined, runner.config],
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={runner.name}
      size="sm"
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <dl className="dk-facts">
        {rows
          .filter(([, v]) => v)
          .map(([k, v, full]) => (
            <div key={k} className="dk-facts-row">
              <dt>{k}</dt>
              <dd className={k === "State" ? undefined : "mono"} title={full}>
                {v}
              </dd>
            </div>
          ))}
      </dl>
    </Dialog>
  );
}

/**
 * One runner (ADR-0032): its name, its folder, a word for its state only when
 * it needs a look, Start or Stop, and the rest in the menu. PID, uptime and
 * binary are under Details; the version shows when it isn't the installed
 * dekit. A problem is one quiet line with the button that fixes it.
 */
export function RunnerRow({ runner, home, live, onChanged }: { runner: RunnerInfo; home: string | undefined; live: boolean; onChanged(): void }) {
  const ctx = useApp();
  const now = useNow(true, 30_000);
  const scope = useMachineScope();
  const remoteName = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  const jobId = useRunnerJob(scope.id, runner.root);
  const job = useJob(jobId);
  const [asking, setAsking] = useState<RunnerAction | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = runner.state === "running" || runner.state === "starting";
  const working = busy || job?.state === "running";
  const host = runner.kind === "host";
  const installed = scope.ms?.tools.dekit;

  const start = async (action: RunnerAction) => {
    setBusy(true);
    setError(null);
    try {
      const j = await ctx.api.dekitRunnerAction(runner.root, action);
      setRunnerJob(scope.id, runner.root, j.id);
      setAsking(null);
    } catch (err) {
      setError(errorText(err));
      if (!asking) ctx.toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const ask = (a: RunnerAction) => (CONFIRM[a] ? (setError(null), setAsking(a)) : void start(a));

  const items: MenuItem[] = [];
  if (running) {
    items.push({ label: "Stop and save", icon: "stop", onSelect: () => ask("down") });
    items.push({ label: "Stop without saving", icon: "xCircle", onSelect: () => ask("stop") });
    if (live) {
      items.push({ label: "Restart runner", icon: "restart", onSelect: () => ask("restart") });
      items.push({ label: "Upgrade to selected dekit", icon: "arrowUp", onSelect: () => ask("upgrade") });
    }
  }
  if (runner.state === "stale") items.push({ label: "Start again", icon: "play", onSelect: () => ask("up") });
  if (runner.configExists && (runner.watched || host)) {
    items.push({ label: "Edit configuration", icon: "pencil", onSelect: () => navigate({ view: "projects", runner: { machine: scope.id, root: runner.root } }) });
  }
  if (!host && !scope.remote) items.push({ label: "Open folder", icon: "folder", onSelect: () => void ctx.pending.run(`reveal|${runner.root}`, null, () => ctx.api.reveal("local", runner.root)) });
  items.push({ label: "Details…", icon: "info", onSelect: () => setDetails(true) });

  const since = sinceText(runner.since, now);
  const confirm = asking ? CONFIRM[asking] : undefined;
  // the word shows when something needs a look; a stale record says what it is in its own line below
  const lookAt = runner.state === "starting" || runner.state === "failed";
  const otherVersion = runner.version && installed && runner.version !== installed ? runner.version : null;
  // The kernel warning says what restartRequired says: the line below says it once.
  const warnings = runner.restartRequired ? runner.warnings.filter((w) => !w.startsWith("kernel:")) : runner.warnings;
  const path = host ? (runner.config ?? "") : runner.root;
  return (
    <li className={`dk-runner state-${runner.state}`}>
      <div className="dk-runner-main">
        <StateDot state={runnerTone(runner)} />
        <div className="dk-runner-text">
          <span className="dk-runner-name">
            {runner.watched && !host ? <a href={href({ view: "projects", runner: { machine: scope.id, root: runner.root } })}>{runner.name}</a> : runner.name}
            {!runner.watched && !host && (
              <span className="tag" title="Its folder isn't one Portplane watches, so its apps don't show in Apps.">
                outside your folders
              </span>
            )}
          </span>
          <span className="dk-runner-path">
            <span className="mono" title={path}>
              {shortenPath(path, home)}
            </span>
            {otherVersion && <span title={runner.binary}> · dekit {otherVersion}</span>}
          </span>
        </div>
        <span className={`dk-state dk-state-${runner.state}`}>{lookAt ? RUNNER_STATE_LABEL[runner.state] : <span className="sr-only">{RUNNER_STATE_LABEL[runner.state]}</span>}</span>
        <div className="dk-runner-actions">
          {!running && runner.state !== "stale" && (
            <button type="button" className="btn btn-sm" disabled={working} aria-busy={working || undefined} onClick={() => void start("up")}>
              {working ? <Spinner size={12} /> : <Icon name="play" size={12} />}
              Start
            </button>
          )}
          {running && (
            <button type="button" className="btn btn-sm" disabled={working} aria-busy={working || undefined} onClick={() => ask("down")}>
              {working ? <Spinner size={12} /> : <Icon name="stop" size={12} />}
              Stop
            </button>
          )}
          <Menu label={`More actions for ${runner.name}`} items={items} />
        </div>
      </div>
      {runner.error && <p className="dk-runner-line dk-warn-error">{runner.error}</p>}
      {runner.state === "stale" && (
        <p className="dk-runner-line">
          <span>Its process is gone: it crashed, or the computer restarted.</span>
          <button type="button" className="btn btn-sm" disabled={working} aria-busy={working || undefined} onClick={() => ask("up")}>
            {working ? <Spinner size={12} /> : <Icon name="play" size={12} />}
            Start again
          </button>
        </p>
      )}
      {runner.restartRequired && (
        <p className="dk-runner-line" title={runner.warnings.find((w) => w.startsWith("kernel:"))}>
          <Icon name="warning" size={13} className="dk-line-icon" />
          <span>The project now selects another dekit binary.</span>
          {running && live && (
            <button type="button" className="btn btn-sm" disabled={working} onClick={() => ask("upgrade")}>
              <Icon name="arrowUp" size={12} />
              Switch to it
            </button>
          )}
        </p>
      )}
      {runner.selectionError && <p className="dk-runner-line">{runner.selectionError}</p>}
      {warnings.map((w) => (
        <p key={w} className="dk-runner-line">
          <Icon name="warning" size={13} className="dk-line-icon" />
          <span>{w}</span>
        </p>
      ))}
      <RunnerJob root={runner.root} />
      {details && <RunnerDetails runner={runner} home={home} since={running ? since : ""} onClose={() => setDetails(false)} />}
      {asking && confirm && (
        <ConfirmDialog
          open
          title={confirm.title(runnerName(runner, remoteName))}
          confirmLabel={confirm.label}
          tone={asking === "stop" || asking === "down" ? "danger" : "primary"}
          busy={busy}
          error={error}
          onClose={() => setAsking(null)}
          onConfirm={() => void start(asking).then(onChanged)}
        >
          <p className="dialog-text">{confirm.body}</p>
        </ConfirmDialog>
      )}
    </li>
  );
}
