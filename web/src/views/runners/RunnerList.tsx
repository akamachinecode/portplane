import { useState } from "react";
import type { RunnerAction, RunnerInfo } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import { useApp } from "../../components/AppContext";
import { ConfirmDialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { Menu, type MenuItem } from "../../components/Menu";
import { StateDot } from "../../components/StateDot";
import { useNow } from "../../hooks/useNow";
import { RUNNER_STATE_LABEL, runnerTone, sinceText } from "../../lib/dekit/why";
import { shortenPath } from "../../lib/format";
import { href, navigate } from "../../lib/router";
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
    body: "Stops the runner and every task in it, and forgets them: its next start begins fresh from dekit.yaml. To pick up where you left off next time, use Stop and save instead.",
    label: "Stop without saving",
  },
  restart: {
    title: (n) => `Restart ${n}?`,
    body: "Restarts the runner in place and reloads dekit.yaml. Running tasks keep running.",
    label: "Restart runner",
  },
  upgrade: {
    title: (n) => `Upgrade ${n}?`,
    body: "Switches the running runner to the dekit binary its project selects, in place. Tasks keep running.",
    label: "Upgrade",
  },
};

function runnerName(r: RunnerInfo): string {
  return r.kind === "host" ? "this computer's runner" : r.name;
}

/** The job a runner's last action started, inline under its row. */
export function RunnerJob({ root }: { root: string }) {
  const id = useRunnerJob(root);
  const job = useJob(id);
  if (!id || !job) return null;
  return (
    <div className="runner-job">
      <JobCard job={job} lines={6} headingLevel={4} />
      {job.state !== "running" && (
        <button type="button" className="btn btn-sm btn-ghost runner-job-dismiss" onClick={() => setRunnerJob(root, null)}>
          Dismiss
        </button>
      )}
    </div>
  );
}

export function RunnerRow({ runner, home, live, onChanged }: { runner: RunnerInfo; home: string | undefined; live: boolean; onChanged(): void }) {
  const ctx = useApp();
  const now = useNow(true, 30_000);
  const jobId = useRunnerJob(runner.root);
  const job = useJob(jobId);
  const [asking, setAsking] = useState<RunnerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = runner.state === "running" || runner.state === "starting";
  const working = busy || job?.state === "running";
  const host = runner.kind === "host";

  const start = async (action: RunnerAction) => {
    setBusy(true);
    setError(null);
    try {
      const j = await ctx.api.dekitRunnerAction(runner.root, action);
      setRunnerJob(runner.root, j.id);
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
    items.push({ label: "Edit configuration", icon: "pencil", onSelect: () => navigate({ view: "projects", runner: { machine: "local", root: runner.root } }) });
  }
  if (!host) items.push({ label: "Open folder", icon: "folder", onSelect: () => void ctx.pending.run(`reveal|${runner.root}`, null, () => ctx.api.reveal("local", runner.root)) });

  const since = sinceText(runner.since, now);
  const confirm = asking ? CONFIRM[asking] : undefined;
  return (
    <li className={`dk-runner state-${runner.state}`}>
      <div className="dk-runner-main">
        <StateDot state={runnerTone(runner)} />
        <div className="dk-runner-text">
          <span className="dk-runner-name">
            {runner.watched && !host ? <a href={href({ view: "projects", runner: { machine: "local", root: runner.root } })}>{runner.name}</a> : runner.name}
            {runner.restartRequired && (
              <span className="tag tag-warn" title="The project now selects another dekit binary: Restart or Upgrade switches to it.">
                Needs restart
              </span>
            )}
            {!runner.watched && !host && (
              <span className="tag" title="Its folder isn't one Portplane watches, so its apps don't show in Apps.">
                not watched
              </span>
            )}
          </span>
          <span className="dk-runner-path mono" title={host ? runner.config : runner.root}>
            {host ? shortenPath(runner.config ?? "", home) : shortenPath(runner.root, home)}
          </span>
        </div>
        <dl className="dk-runner-facts">
          <div>
            <dt className="sr-only">State</dt>
            <dd className={`dk-state dk-state-${runner.state}`}>{RUNNER_STATE_LABEL[runner.state]}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd className="mono">{runner.pid ?? "–"}</dd>
          </div>
          <div>
            <dt className="sr-only">Version</dt>
            <dd className="mono" title={runner.binary}>
              {runner.version ? `v${runner.version}` : "–"}
            </dd>
          </div>
          <div className="dk-runner-since">
            <dt className="sr-only">Running</dt>
            <dd>{running && since ? since : runner.state === "stale" ? "process gone" : ""}</dd>
          </div>
        </dl>
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
          {items.length > 0 && <Menu label={`More actions for ${runner.name}`} items={items} />}
        </div>
      </div>
      {(runner.warnings.length > 0 || runner.error || runner.selectionError) && (
        <ul className="dk-runner-warnings">
          {runner.error && <li className="dk-warn-error">{runner.error}</li>}
          {runner.selectionError && <li>{runner.selectionError}</li>}
          {runner.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {runner.state === "stale" && (
        <p className="dk-runner-note">dekit has a record for this runner, but its process is gone (it crashed or the computer restarted). Start it again, or clean stale records.</p>
      )}
      <RunnerJob root={runner.root} />
      {asking && confirm && (
        <ConfirmDialog
          open
          title={confirm.title(runnerName(runner))}
          confirmLabel={confirm.label}
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
