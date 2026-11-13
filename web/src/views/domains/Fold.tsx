import { useId, type ReactNode } from "react";
import type { FileChange } from "../../api/types";
import { FileDiff } from "../../components/FileDiff";
import { dirOf } from "../../lib/dekit/taskForm";
import { Fold } from "../../components/Fold";
import { inferHome, shortenPath } from "../../lib/format";
import { StateDot } from "../../components/StateDot";

export { Fold };

type DotState = Parameters<typeof StateDot>[0]["state"];

// The calm pieces portless's pages share (ADR-0032): a fold for details on
// demand (shared, in components/Fold.tsx), a titled group with room for its
// actions, and one status line.

/**
 * A titled block like SettingsGroup (the same look), with its actions on
 * the right of the title, so a card doesn't need a row just for a button.
 */
export function Group({ title, description, actions, children, id: forced }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  const auto = useId();
  const id = forced ?? auto;
  // the page's main card, under a title that already names it, has no title of its own (ADR-0032: say it once)
  if (!title) {
    return (
      <section className="sgroup">
        <div className="sgroup-body">{children}</div>
      </section>
    );
  }
  return (
    <section className="sgroup" aria-labelledby={id}>
      <header className="sgroup-head group-head">
        <div className="group-head-text">
          <h2 className="sgroup-title" id={id}>
            {title}
          </h2>
          {description && <p className="sgroup-desc">{description}</p>}
        </div>
        {actions && <div className="group-head-actions">{actions}</div>}
      </header>
      <div className="sgroup-body">{children}</div>
    </section>
  );
}

/** The one line that says how something stands, with its likely action on the right. */
export function StatusLine({ state, children, sub, actions }: { state?: DotState; children: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`status-line${state ? " has-dot" : ""}`}>
      <div className="status-line-text">
        <p className="status-line-main">
          {state && <StateDot state={state} />}
          <span>{children}</span>
        </p>
        {sub && <p className="status-line-sub">{sub}</p>}
      </div>
      {actions && <div className="status-line-actions">{actions}</div>}
    </div>
  );
}

/** A label and a value, for the rows inside a fold of details (in a <dl className="dfacts">). */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="dfacts-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A path with the home folder as ~, the whole path in its tooltip. */
export function ShortPath({ path }: { path: string }) {
  return (
    <span className="mono path-value" title={path}>
      {shortenPath(path, inferHome([path]))}
    </span>
  );
}

/**
 * What a change writes and runs, folded (ADR-0032): the dialog says what it
 * does in a sentence; the diff and the steps are there for whoever checks.
 */
export function ChangeFold({ files, steps, runner }: { files: FileChange[]; steps: string[]; /** The runner's folder, else each file's own */ runner?: string }) {
  if (files.length === 0 && steps.length === 0) return null;
  const names = files.map((f) => f.path.split(/[/\\]/).pop() ?? f.path);
  return (
    <Fold summary="What changes" hint={names.length ? names.join(", ") : undefined} className="change-fold">
      {files.map((f) => (
        <FileDiff key={f.path} file={f} folder={runner ?? dirOf(f.path)} />
      ))}
      {steps.length > 0 && (
        <ol className="rename-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </Fold>
  );
}
