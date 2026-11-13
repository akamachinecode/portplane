import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppProposal, Proposal } from "../api/types";
import {
  assignBuckets,
  bucketGroups,
  cleanName,
  effectiveName,
  isIncluded,
  nameClashes,
  nameProblem,
  shortDir,
  urlForName,
  type ProposalGroup,
  type SetupBucket,
  type SetupEdits,
} from "../lib/setup";
import { Icon } from "./Icon";
import "./SetupApps.css";

// The apps a scan found (ADR-0032): grouped by what writing does to them,
// the decisions (new, changed) open and the rest folded, with what a group
// means said once in its header instead of on every row. One line per app:
// its name, framework, folder and the address it gets; the folder in full,
// the package, the command and any notes are behind the row's details.

const BUCKETS: Record<SetupBucket, { title: string; hint: string }> = {
  new: { title: "New", hint: "Writing adds them." },
  changed: { title: "Changed", hint: "Their tasks change when you write." },
  unchanged: { title: "Unchanged", hint: "Already set up like this." },
  skipped: { title: "Left out", hint: "Not set up. Tick one to add it." },
  manual: { title: "Already set up by hand", hint: "Their tasks are in dekit.yaml, and Portplane leaves them alone." },
};

/** A note that only repeats what the group header says. */
const SAID_BY_GROUP = /configured by hand/i;

interface RowProps {
  app: AppProposal;
  edits: SetupEdits;
  clash: boolean;
  onName(task: string, value: string | undefined): void;
  onInclude(task: string, include: boolean): void;
}

function NameField({ app, edits, clash, onName, id }: Omit<RowProps, "onInclude"> & { id: string }) {
  const included = isIncluded(app, edits);
  const typed = edits.names[app.task];
  const value = typed ?? app.name;
  const problem = typed !== undefined ? nameProblem(typed) : null;
  const error = problem ?? (clash && included ? "Another app already has this address." : null);
  return (
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
        aria-label={`Address of ${app.task}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-url`}
        onChange={(e) => onName(app.task, e.target.value)}
      />
      <span className="name-affix" aria-hidden="true">
        .localhost
      </span>
    </div>
  );
}

function ProposalRow({ app, edits, clash, onName, onInclude }: RowProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const manual = app.status === "manual";
  const included = isIncluded(app, edits);
  const typed = edits.names[app.task];
  const problem = typed !== undefined ? nameProblem(typed) : null;
  const error = problem ?? (clash && included ? "Another app already has this address." : null);
  const clean = typed !== undefined ? cleanName(typed) : app.name;
  const label = app.task.split("/").pop() ?? app.task;
  const notes = (app.notes ?? []).filter((n) => !(manual && SAID_BY_GROUP.test(n)));
  const where = [app.dir, app.package && app.package !== label ? app.package : null].filter(Boolean).join(" · ");

  return (
    <li className={`sa-row${included ? "" : " is-off"}${manual ? " is-manual" : ""}${notes.length ? " has-notes" : ""}`}>
      <div className="sa-line">
        {manual ? (
          <span className="sa-check" aria-hidden="true" />
        ) : (
          <input
            id={`${id}-on`}
            type="checkbox"
            className="sa-check"
            checked={included}
            onChange={(e) => onInclude(app.task, e.target.checked)}
            aria-label={`Set up ${app.task}`}
          />
        )}
        <span className="sa-what">
          {manual ? (
            <span className="sa-name" title={app.task}>
              {label}
            </span>
          ) : (
            <label htmlFor={`${id}-on`} className="sa-name" title={app.task}>
              {label}
            </label>
          )}
          <span className="sa-meta" title={where}>
            {app.framework}
            <span aria-hidden="true"> · </span>
            <span className="sa-dir">{shortDir(app.dir)}</span>
          </span>
        </span>
        {!manual && <NameField app={app} edits={edits} clash={clash} onName={onName} id={id} />}
        <span className="sa-more-slot">
          <button
            type="button"
            className={notes.length ? "link-btn sa-more" : "icon-btn sa-more sa-more-quiet"}
            aria-expanded={open}
            aria-controls={`${id}-more`}
            aria-label={notes.length ? undefined : `Details of ${label}`}
            title={notes.length ? undefined : "Details"}
            onClick={() => setOpen((v) => !v)}
          >
            {notes.length > 0 && (notes.length === 1 ? "1 note" : `${notes.length} notes`)}
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
          </button>
        </span>
      </div>
      {!manual && (error || (included && typed !== undefined)) && (
        <div className="sa-under name-under">
          {error ? (
            <p className="field-error" id={`${id}-url`}>
              {error}
            </p>
          ) : (
            <p className="name-url" id={`${id}-url`}>
              {clean !== (typed ?? "").trim() && clean ? (
                <>
                  Becomes <span className="mono">{urlForName(effectiveName(app, edits))}</span>
                </>
              ) : null}
            </p>
          )}
          {typed !== undefined && included && (
            <button type="button" className="link-btn" onClick={() => onName(app.task, undefined)}>
              Reset
            </button>
          )}
        </div>
      )}
      {!manual && !error && !(included && typed !== undefined) && (
        <span className="sr-only" id={`${id}-url`}>
          {urlForName(effectiveName(app, edits))}
        </span>
      )}
      <div className="sa-details" id={`${id}-more`} hidden={!open}>
        {notes.length > 0 && (
          <ul className="sa-notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <dl className="sa-facts">
          <div>
            <dt>Folder</dt>
            <dd className="mono">{app.dir}</dd>
          </div>
          {app.package && (
            <div>
              <dt>Package</dt>
              <dd className="mono">
                {app.package}
                {app.packageManager && <span className="muted"> ({app.packageManager})</span>}
              </dd>
            </div>
          )}
          {!manual && app.command.length > 0 && (
            <div>
              <dt>Runs</dt>
              <dd className="mono">{app.command.join(" ")}</dd>
            </div>
          )}
        </dl>
      </div>
    </li>
  );
}

/** A group with a header that folds it; what it means is said once, there. */
function Group({
  title,
  count,
  hint,
  defaultOpen,
  actions,
  tone,
  children,
}: {
  title: string;
  count?: number;
  hint?: ReactNode;
  defaultOpen: boolean;
  actions?: ReactNode;
  tone?: "removed";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`sa-group${open ? " is-open" : ""}${tone ? ` is-${tone}` : ""}`} aria-labelledby={`${id}-title`}>
      <div className="sa-group-head">
        <h3 className="sa-group-title" id={`${id}-title`}>
          <button type="button" className="sa-group-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
            {title}
            {count !== undefined && <span className="sa-group-count">{count}</span>}
          </button>
        </h3>
        {hint && <p className="sa-group-hint">{hint}</p>}
        {actions && open && <span className="sa-group-actions">{actions}</span>}
      </div>
      <div id={id} className="sa-group-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** One bucket's apps, with a small heading per project and checkout when there is more than one. */
function Rows({
  groups,
  headed,
  edits,
  clashes,
  onName,
  onInclude,
}: {
  groups: ProposalGroup[];
  /** Whether the folder has more than one project or checkout, so a row needs one to make sense. */
  headed: boolean;
  edits: SetupEdits;
  clashes: Set<string>;
  onName: RowProps["onName"];
  onInclude: RowProps["onInclude"];
}) {
  const parts = groups.flatMap((g) => g.worktrees.map((wt) => ({ project: g.project, worktree: wt.worktree, apps: wt.apps })));
  return (
    <>
      {parts.map((p) => (
        <div key={`${p.project}\u0000${p.worktree}`} className="sa-part">
          {headed && (
            <p className="sa-part-head">
              {p.project}
              {p.worktree && (
                <span className="sa-part-wt">
                  <Icon name="branch" size={13} />
                  {p.worktree}
                </span>
              )}
            </p>
          )}
          <ul className="sa-rows">
            {p.apps.map((a) => (
              <ProposalRow key={a.task} app={a} edits={edits} clash={clashes.has(a.task)} onName={onName} onInclude={onInclude} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** What a scan says to check once the apps run: one line, the details on demand. */
function Warnings({ warnings, projects }: { warnings: string[]; projects: string[] }) {
  const named = [...new Set(warnings.map((w) => w.split(":")[0]).filter((p) => projects.includes(p)))];
  const what = warnings.length === 1 ? "One thing to check" : `${warnings.length} things to check`;
  return (
    <details className="sa-warn">
      <summary>
        <Icon name="warning" size={15} />
        <span>
          {what} once your apps run{named.length ? `, in ${named.join(" and ")}` : ""}.
        </span>
        <span className="sa-warn-why">Why</span>
      </summary>
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

/** The apps a scan found, by what writing does to them, with names and skips to edit. */
export function SetupApps({
  proposal,
  edits,
  onName,
  onInclude,
  onIncludeAll,
}: {
  proposal: Proposal;
  edits: SetupEdits;
  onName(task: string, value: string | undefined): void;
  onInclude(task: string, include: boolean): void;
  /** Ticks or unticks every app of a group at once ("All / None"). */
  onIncludeAll?(tasks: string[], include: boolean): void;
}) {
  // Each app keeps the group it was first shown in, so a tick never moves its
  // row. The groups depend on the apps only, not on what is typed: worked out
  // once per scan, not on every keystroke.
  const known = useRef(new Map<string, SetupBucket>());
  const { buckets, projects, checkouts } = useMemo(() => {
    known.current = assignBuckets(proposal.apps, known.current);
    return {
      buckets: bucketGroups(proposal.apps, known.current),
      projects: [...new Set(proposal.apps.map((a) => a.project))],
      checkouts: new Set(proposal.apps.map((a) => `${a.project}\u0000${a.worktree ?? ""}`)),
    };
  }, [proposal.apps]);
  const clashes = nameClashes(proposal.apps, edits);
  const decisions = buckets.some((b) => b.bucket === "new" || b.bucket === "changed");
  const removed = proposal.change.removed;
  const unsupported = proposal.unsupported ?? [];

  const allOrNone = (apps: AppProposal[]) => {
    const editable = apps.filter((a) => a.status !== "manual");
    if (!onIncludeAll || editable.length < 2) return undefined;
    const on = editable.filter((a) => isIncluded(a, edits)).length;
    const tasks = editable.map((a) => a.task);
    return (
      <>
        <button type="button" className="link-btn" disabled={on === editable.length} onClick={() => onIncludeAll(tasks, true)}>
          All
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link-btn" disabled={on === 0} onClick={() => onIncludeAll(tasks, false)}>
          None
        </button>
      </>
    );
  };

  return (
    <div className="setup-step sa">
      {proposal.warnings.length > 0 && <Warnings warnings={proposal.warnings} projects={projects} />}

      {buckets.length === 0 && unsupported.length === 0 && (
        <div className="sa-empty">
          <p className="sa-empty-title">No apps found</p>
          <p className="muted">
            Setup looks for a <code>package.json</code> with a <code>dev</code> script, in this folder or one level down, workspaces and git worktrees
            included.
          </p>
        </div>
      )}

      {buckets.map((b) => (
        <Group
          key={b.bucket}
          title={BUCKETS[b.bucket].title}
          count={b.apps.length}
          hint={BUCKETS[b.bucket].hint}
          defaultOpen={b.bucket === "new" || b.bucket === "changed" || (b.bucket === "unchanged" && !decisions)}
          actions={b.bucket === "manual" ? undefined : allOrNone(b.apps)}
        >
          <Rows groups={b.groups} headed={checkouts.size > 1} edits={edits} clashes={clashes} onName={onName} onInclude={onInclude} />
        </Group>
      ))}

      {removed.length > 0 && (
        <Group title="Removed" count={removed.length} hint="Their app is gone or left out, so writing takes their tasks out." defaultOpen tone="removed">
          <ul className="sa-rows sa-removed">
            {removed.map((t) => (
              <li key={t} className="sa-row">
                <div className="sa-line">
                  <Icon name="minus" size={14} />
                  <span className="mono">
                    <span className="sr-only">Removed: </span>
                    {t}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {unsupported.length > 0 && (
        <Group title="Not supported yet" count={unsupported.length} hint="Setup writes tasks for JavaScript and TypeScript apps only, for now." defaultOpen={false}>
          <p className="sa-group-text">
            To run {unsupported.length === 1 ? "this one" : "these"} with Portplane, add a task to its <code>dekit.yaml</code> with{" "}
            <code>portless &lt;name&gt; &lt;command&gt;</code>; Portplane then shows it like any other app.
          </p>
          <ul className="sa-rows">
            {unsupported.map((p) => (
              <li key={p.dir} className="sa-row">
                <div className="sa-line">
                  <span className="sa-check" aria-hidden="true" />
                  <span className="sa-what">
                    <span className="sa-name mono" title={p.dir}>
                      {shortDir(p.dir)}
                    </span>
                    <span className="sa-meta">{p.kinds.join(", ")}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Group>
      )}
    </div>
  );
}
