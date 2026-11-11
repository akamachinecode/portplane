import { useId } from "react";
import type { AppProposal, Proposal, ProposalStatus } from "../api/types";
import {
  cleanName,
  effectiveName,
  groupProposalApps,
  isIncluded,
  nameClashes,
  nameProblem,
  urlForName,
  type SetupEdits,
} from "../lib/setup";
import { Banner } from "./Banner";
import { Icon } from "./Icon";

type ShownStatus = ProposalStatus | "pending";

const STATUS: Record<ShownStatus, { label: string; title: string }> = {
  pending: { label: "updating…", title: "Waiting for the new scan" },
  new: { label: "new", title: "Not in the generated config yet: writing adds it" },
  changed: { label: "changed", title: "Its task in .portplane/tasks.yaml will change" },
  unchanged: { label: "unchanged", title: "Already in the generated config, as proposed" },
  manual: { label: "hand-written", title: "Configured by hand in dekit.yaml: Portplane leaves it alone" },
  skipped: { label: "skipped", title: "You chose not to set this one up" },
};

interface AppRowProps {
  app: AppProposal;
  edits: SetupEdits;
  clash: boolean;
  onName(task: string, value: string | undefined): void;
  onInclude(task: string, include: boolean): void;
}

function ProposalRow({ app, edits, clash, onName, onInclude }: AppRowProps) {
  const id = useId();
  const manual = app.status === "manual";
  const included = isIncluded(app, edits);
  const typed = edits.names[app.task];
  const value = typed ?? app.name;
  const problem = typed !== undefined ? nameProblem(typed) : null;
  const clean = typed !== undefined ? cleanName(typed) : app.name;
  const shown = effectiveName(app, edits);
  const label = app.task.split("/").pop() ?? app.task;
  // Unticking shows "skipped" at once; ticking again waits for the re-scan
  // to say whether the task is new, changed or unchanged.
  const status: ShownStatus = manual ? "manual" : !included ? "skipped" : app.skipped ? "pending" : app.status;
  const error = problem ?? (clash && included ? "Another app already has this URL." : null);

  return (
    <li className={`setup-app${included ? "" : " is-off"}${manual ? " is-manual" : ""}`}>
      <input
        id={`${id}-on`}
        type="checkbox"
        className="setup-check"
        checked={included}
        disabled={manual}
        onChange={(e) => onInclude(app.task, e.target.checked)}
        aria-label={`Set up ${app.task}`}
        aria-describedby={`${id}-meta`}
      />
      <div className="setup-app-main">
        <div className="setup-app-line">
          <label htmlFor={`${id}-on`} className="setup-app-label" title={app.task}>
            {label}
          </label>
          <span className={`badge badge-${status}`} title={STATUS[status].title}>
            {STATUS[status].label}
          </span>
          <span className="tag" title={`Package manager: ${app.packageManager}`}>
            {app.framework}
          </span>
        </div>
        <div className="setup-app-meta" id={`${id}-meta`}>
          <span className="mono" title={app.dir}>
            {app.dir}
          </span>
          {app.package && app.package !== label && <span className="setup-app-pkg">{app.package}</span>}
        </div>
        {!manual && app.command.length > 0 && included && (
          <code className="setup-app-cmd" title={app.command.join(" ")}>
            {app.command.join(" ")}
          </code>
        )}
        {app.notes && app.notes.length > 0 && (
          <ul className="setup-notes">
            {app.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      {!manual && (
        <div className="setup-app-name">
          <label className="sr-only" htmlFor={`${id}-name`}>
            portless name for {app.task}
          </label>
          <div
            className={`name-field${error ? " has-error" : ""}${included ? "" : " is-disabled"}`}
            onMouseDown={(e) => {
              // the whole field focuses the input, not only the text
              const input = e.currentTarget.querySelector("input");
              if (input && e.target !== input) {
                e.preventDefault();
                input.focus();
              }
            }}
          >
            <span className="name-affix" aria-hidden="true">
              https://
            </span>
            <input
              id={`${id}-name`}
              className="name-input mono"
              type="text"
              value={value}
              style={{ width: `calc(${Math.max(4, value.length)}ch + 2px)` }}
              disabled={!included}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-url`}
              onChange={(e) => onName(app.task, e.target.value)}
            />
            <span className="name-affix" aria-hidden="true">
              .localhost
            </span>
          </div>
          <div className="name-under">
            {error ? (
              <p className="field-error" id={`${id}-url`}>
                {error}
              </p>
            ) : (
              <p className="name-url" id={`${id}-url`}>
                {included && clean !== value.trim() ? (
                  <>
                    Becomes <span className="mono">{urlForName(shown)}</span>
                  </>
                ) : (
                  <span className="sr-only">{urlForName(shown)}</span>
                )}
              </p>
            )}
            {typed !== undefined && included && (
              <button type="button" className="link-btn" onClick={() => onName(app.task, undefined)}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Step 2: the apps a scan found, grouped by project and checkout, with names and skips to edit. */
export function SetupApps({
  proposal,
  edits,
  onName,
  onInclude,
}: {
  proposal: Proposal;
  edits: SetupEdits;
  onName(task: string, value: string | undefined): void;
  onInclude(task: string, include: boolean): void;
}) {
  const groups = groupProposalApps(proposal.apps);
  const clashes = nameClashes(proposal.apps, edits);

  return (
    <div className="setup-step">
      {proposal.warnings.length > 0 && (
        <Banner tone="warn" title={proposal.warnings.length === 1 ? "One thing to check" : `${proposal.warnings.length} things to check`}>
          <ul className="setup-warnings">
            {proposal.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      {groups.length === 0 && (
        <div className="panel setup-empty">
          <p className="panel-title">No apps found</p>
          <p className="panel-text">
            Setup looks for JavaScript and TypeScript projects: a <code>package.json</code> with a <code>dev</code> script, in this folder
            or one level down, including workspaces and git worktrees.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.project} className="setup-project" aria-label={g.project}>
          <h3 className="setup-project-name">{g.project}</h3>
          {g.worktrees.map((wt) => (
            <div key={wt.worktree} className="setup-wt">
              {(g.worktrees.length > 1 || wt.worktree) && (
                <div className="setup-wt-head">
                  <Icon name="branch" size={13} />
                  {wt.worktree ? (
                    <>
                      worktree <strong>{wt.worktree}</strong>
                    </>
                  ) : (
                    "main checkout"
                  )}
                </div>
              )}
              <ul className="setup-apps">
                {wt.apps.map((a) => (
                  <ProposalRow key={a.task} app={a} edits={edits} clash={clashes.has(a.task)} onName={onName} onInclude={onInclude} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}

      {proposal.change.removed.length > 0 && (
        <section className="setup-removed" aria-labelledby="setup-removed-title">
          <h3 id="setup-removed-title" className="setup-removed-title">
            <Icon name="trash" size={14} />
            {proposal.change.removed.length === 1 ? "1 task will be removed" : `${proposal.change.removed.length} tasks will be removed`}
          </h3>
          <p className="setup-removed-text">
            They are in <code>.portplane/tasks.yaml</code>, but their app is gone or you skipped it.
          </p>
          <ul className="setup-removed-list">
            {proposal.change.removed.map((t) => (
              <li key={t} className="mono">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
