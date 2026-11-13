import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import { useJob, useJobs } from "../../api/jobs";
import type { SelfUpdatePlan, UpdateItem } from "../../api/polish";
import type { Preferences } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { CommandLine } from "../../components/Controls";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { Segmented } from "../../components/Segmented";
import { StateDot } from "../../components/StateDot";
import { useNow } from "../../hooks/useNow";
import { href } from "../../lib/router";
import { timeAgo } from "../../lib/timeAgo";
import { portplaneUpdate, setUpdateCheck, useUpdateCheck } from "../../lib/updateCheck";
import { useShell } from "../../shell/ShellContext";
import { SettingRow, SettingsGroup } from "./SettingsGroup";
import "./updates.css";

const UPDATE_OPTIONS = [
  { value: "manual" as Preferences["updateCheck"], label: "When I ask" },
  { value: "auto" as Preferences["updateCheck"], label: "Once a day" },
];

const RELEASES = "https://github.com/akamachinecode/portplane/releases/latest";

/** What to do about one tool's answer: nothing, read what is new, or update it where it is installed. */
function UpdateRow({ item }: { item: UpdateItem }) {
  const version = item.installed ? <span className="mono">{item.installed}</span> : <span className="muted">Not installed</span>;
  let status;
  if (item.error) status = <span className="update-status update-error">Couldn't check: {item.error}</span>;
  else if (item.update)
    status = (
      <span className="update-status update-new">
        <strong className="mono">{item.latest}</strong> is out
      </span>
    );
  else if (item.installed) status = <span className="update-status muted">Up to date</span>;
  else status = <span className="update-status muted">Latest is {item.latest}</span>;

  return (
    <li className="update-row">
      <StateDot state={item.error ? "unknown" : item.update ? "starting" : "on"} />
      <span className="update-name">{item.name}</span>
      <span className="update-version">{version}</span>
      {status}
      <span className="update-actions">
        {item.notes && item.update && (
          <a className="btn btn-sm btn-ghost" href={item.notes} target="_blank" rel="noopener noreferrer">
            What's new
            <Icon name="open" size={13} />
          </a>
        )}
        {item.update && item.id !== "portplane" && (
          <a className="btn btn-sm" href={href(item.id === "dekit" ? { view: "dekit" } : { view: "domains", section: "maintenance" })}>
            Update {item.name}…
          </a>
        )}
      </span>
    </li>
  );
}

/** What "Update and restart" replaces, in words. */
function whereText(plan: SelfUpdatePlan): string {
  switch (plan.method) {
    case "app":
      return `Replaces ${plan.where ?? "Portplane.app"} and opens the new version.`;
    case "deb":
    case "rpm":
      return `Installs the new .${plan.method} package, which asks for your password, and opens the new version.`;
    default:
      return `Replaces Portplane in ${plan.where ?? "its folder"} and opens the new version.`;
  }
}

/**
 * The new Portplane (ADR-0031): "Update and restart" when Portplane can
 * update itself, with the job's progress; otherwise why not, and how.
 */
function SelfUpdate({ item }: { item: UpdateItem }) {
  const { api, toast } = useApp();
  const { jobs } = useJobs();
  const [plan, setPlan] = useState<SelfUpdatePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const started = useJob(jobId);
  // An update started earlier, from another page, still shows here.
  const job = started ?? jobs.find((j) => j.kind === "update" && j.state === "running");
  const version = item.latest ?? "";

  useEffect(() => {
    let live = true;
    api.selfUpdatePlan().then(
      (p) => live && setPlan(p),
      (err: unknown) => live && setPlanError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [api, version]);

  const install = async () => {
    setStarting(true);
    try {
      const j = await api.installUpdate(version);
      setJobId(j.id);
    } catch (err) {
      toast.error(`Couldn't update Portplane: ${errorText(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const busy = starting || job?.state === "running";
  const restarting = job?.state === "succeeded";
  return (
    <div className="self-update">
      <div className="self-update-head">
        <Icon name="download" size={18} className="self-update-icon" />
        <div className="self-update-text">
          <p className="self-update-title">
            Portplane <span className="mono">{version}</span> is ready
          </p>
          <p className="self-update-sub">
            {planError
              ? `Couldn't tell how Portplane was installed: ${planError}`
              : !plan
                ? "Looking at how Portplane was installed…"
                : plan.auto
                  ? whereText(plan)
                  : plan.reason}
          </p>
        </div>
        {plan?.auto && !restarting && (
          <button
            type="button"
            className="btn btn-primary"
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            title={plan.password ? "Asks for your password" : undefined}
            onClick={() => !busy && void install()}
          >
            {busy ? <Spinner /> : <Icon name="restart" size={14} />}
            {busy ? "Updating…" : "Update and restart"}
          </button>
        )}
        {plan && !plan.auto && (
          <a className="btn" href={item.notes ?? RELEASES} target="_blank" rel="noopener noreferrer">
            Download
            <Icon name="open" size={13} />
          </a>
        )}
      </div>
      {plan?.auto && plan.password && plan.command && !job && (
        <div className="self-update-command">
          <p className="self-update-sub">After your password, in the system's dialog, it runs:</p>
          <CommandLine command={plan.command} />
        </div>
      )}
      {plan && !plan.auto && plan.command && <CommandLine command={plan.command} />}
      {job && <JobCard job={job} lines={6} headingLevel={3} />}
      {restarting && (
        <p className="self-update-restarting" role="status">
          <Spinner /> Portplane {version} is starting. This window closes and opens again in a moment.
        </p>
      )}
    </div>
  );
}

/**
 * Settings › Updates (ADR-0025, ADR-0031): checks Portplane, dekit and
 * portless on a click, or once a day when the user turns it on. Portplane
 * updates itself on a click; dekit and portless update in their own pages.
 */
export function UpdatesGroup({ prefs }: { prefs: Preferences }) {
  const { api } = useApp();
  const { updatePreferences } = useShell();
  const last = useUpdateCheck();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const now = useNow(!!last, 30_000);

  useEffect(() => {
    let live = true;
    api.updates().then(
      (c) => {
        if (!live) return;
        setUpdateCheck(c);
        setError(null);
      },
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const check = async () => {
    setChecking(true);
    try {
      setUpdateCheck(await api.checkUpdates());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const updates = last?.items.filter((i) => i.update).length ?? 0;
  const self = portplaneUpdate(last);
  return (
    <SettingsGroup
      title="Updates"
      description="Portplane reads the latest versions from GitHub and npm, sends nothing about you, and installs nothing until you click."
    >
      <SettingRow label="Check for new versions" description="Of Portplane, dekit and portless. With “Once a day”, a notification tells you about a new Portplane.">
        <Segmented
          label="Check for new versions"
          value={prefs.updateCheck}
          options={UPDATE_OPTIONS}
          onChange={(updateCheck) => void updatePreferences((x) => ({ ...x, updateCheck, updateAsked: true }))}
        />
      </SettingRow>
      <div className="updates" aria-busy={checking || last === undefined || undefined}>
        {self && <SelfUpdate item={self} />}
        <div className="updates-head">
          <p className="updates-summary" role="status">
            {error
              ? `Couldn't check: ${error}`
              : last === undefined
                ? "Loading the last check…"
                : !last
                  ? "Not checked yet."
                  : `${updates === 0 ? "Everything is up to date" : updates === 1 ? "1 update available" : `${updates} updates available`} · checked ${timeAgo(last.checkedAt, now)}`}
          </p>
          <button type="button" className="btn" aria-busy={checking || undefined} aria-disabled={checking || undefined} onClick={() => !checking && void check()}>
            {checking ? <Spinner /> : <Icon name="restart" size={14} />}
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>
        {last && (
          <ul className="update-list">
            {last.items.map((item) => (
              <UpdateRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  );
}
