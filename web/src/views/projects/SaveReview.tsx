import { useCallback, useEffect, useState } from "react";
import type { EditResult, Reload, ReloadPlan } from "../../api/dekit";
import { ApiError, errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { useScopedMachine } from "../../components/MachineScope";
import { Dialog } from "../../components/Dialog";
import { FileDiff } from "../../components/FileDiff";
import { Icon, Spinner } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { changeText } from "../../lib/dekit/why";

// Saving config (plan §4.4): 1. the file's diff; 2. what the running
// runner would change (dekit reload's plan); 3. "Apply and restart the
// affected tasks". Nothing is written before step 1 is confirmed.

/** dekit reload's plan, one line per task. */
export function ReloadPlanList({ plan }: { plan: ReloadPlan }) {
  if (plan.changes.length === 0 && !plan.order) return <p className="muted">Nothing to apply: the runner already runs this config.</p>;
  return (
    <ul className="reload-plan">
      {plan.changes.map((c) => (
        <li key={`${c.kind}|${c.path}`} className={`reload-change reload-${c.kind}${c.apply ? "" : " is-kept"}`}>
          <Icon name={c.kind === "added" ? "plus" : c.kind === "removed" ? "trash" : "pencil"} size={14} />
          <span className="mono reload-path">{c.path}</span>
          <span className="reload-what">{changeText(c)}</span>
          {!c.apply && <span className="tag">kept</span>}
        </li>
      ))}
      {plan.order && (
        <li className="reload-change">
          <Icon name="rows" size={14} />
          <span className="reload-what">The config lists its tasks in a new order{plan.order.conflict ? " (you also moved some in dekit's console: kept as they are)" : ""}.</span>
        </li>
      )}
      {plan.edited_here.length > 0 && (
        <li className="reload-change is-kept">
          <Icon name="info" size={14} />
          <span className="reload-what">
            Changed in dekit's console and not in the file: {plan.edited_here.join(", ")}. A reload keeps those changes.
          </span>
        </li>
      )}
    </ul>
  );
}

/** "Apply" and "Apply and restart", for a plan the runner has. */
export function useApplyReload(runner: string) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState<"plain" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback(
    async (restart: boolean) => {
      setBusy(restart ? "restart" : "plain");
      setError(null);
      try {
        const res = await api.dekitReload(runner, restart);
        toast.info(res.restarted.length ? `Reloaded and restarted ${res.restarted.join(", ")}` : "Reloaded the config");
        if (res.error) toast.error(res.error);
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, runner, toast],
  );
  return { apply, busy, error };
}

/** How many running tasks a plan would restart. */
export function runningChanged(plan: ReloadPlan | undefined, alive: Set<string>): string[] {
  return (plan?.changes ?? []).filter((c) => c.kind === "changed" && c.apply && alive.has(c.path)).map((c) => c.path);
}

function useAlive(runner: string): Set<string> {
  const ms = useScopedMachine();
  return new Set((ms?.apps ?? []).filter((a) => a.runner === runner && (a.state === "on" || a.state === "starting")).map((a) => a.task));
}

export function ReloadStep({ runner, reload, onDone, saved }: { runner: string; reload: Reload; onDone(): void; saved?: boolean }) {
  const alive = useAlive(runner);
  const { apply, busy, error } = useApplyReload(runner);
  const restart = runningChanged(reload.plan, alive);
  return (
    <div className="review-step">
      <p className="review-lead">
        {saved && <Icon name="checkCircle" size={15} />}
        {saved ? "Saved. Applying it makes the runner do this:" : "Applying makes the runner do this:"}
      </p>
      <ReloadPlanList plan={reload.plan} />
      {reload.errors.length > 0 && (
        <ul className="review-problems">
          {reload.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="review-actions">
        <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={onDone}>
          Not now
        </button>
        <span className="spacer" />
        {restart.length > 0 && (
          <button type="button" className="btn" disabled={!!busy} aria-busy={busy === "plain" || undefined} onClick={() => void apply(false).then((ok) => ok && onDone())}>
            {busy === "plain" && <Spinner />}
            Apply without restarting
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!!busy} aria-busy={busy === "restart" || undefined} onClick={() => void apply(restart.length > 0).then((ok) => ok && onDone())}>
          {busy === "restart" && <Spinner />}
          {restart.length ? `Apply and restart ${restart.length === 1 ? (restart[0].split("/").pop() ?? restart[0]) : `${restart.length} tasks`}` : "Apply"}
        </button>
      </div>
    </div>
  );
}

/**
 * Previews an edit, saves it on confirm, then offers the reload. run(false)
 * previews and run(true) writes (the server checks the digests again).
 */
export function SaveReview({
  title,
  runner,
  folder,
  run,
  onClose,
  onSaved,
}: {
  title: string;
  runner: string;
  folder: string;
  run(write: boolean): Promise<EditResult>;
  onClose(): void;
  onSaved?(res: EditResult): void;
}) {
  const [preview, setPreview] = useState<{ status: "loading" } | { status: "error"; message: string; conflict: boolean; notEditable: boolean } | { status: "ok"; value: EditResult }>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<EditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setPreview({ status: "loading" });
    run(false).then(
      (value) => setPreview({ status: "ok", value }),
      (err: unknown) => setPreview({ status: "error", message: errorText(err), conflict: err instanceof ApiError && err.status === 409, notEditable: err instanceof ApiError && err.status === 422 }),
    );
    // run changes identity with every render of the caller; the preview is for what was asked when the dialog opened
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await run(true);
      if (!res.written) {
        setPreview({ status: "ok", value: res });
        return;
      }
      setSaved(res);
      onSaved?.(res);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const value = preview.status === "ok" ? preview.value : null;
  const changed = value?.files.filter((f) => f.changed) ?? [];
  const blocked = !value || value.problems.length > 0 || changed.length === 0;

  let body;
  if (saved) {
    body = saved.up && saved.reload ? (
      <ReloadStep runner={runner} reload={saved.reload} onDone={onClose} saved />
    ) : (
      <div className="review-step">
        <p className="review-lead">
          <Icon name="checkCircle" size={15} /> Saved.{" "}
          {saved.up ? (saved.reloadError ? `dekit couldn't read the new config: ${saved.reloadError}` : "") : "The runner isn't running: it reads the new config when it starts."}
        </p>
      </div>
    );
  } else if (preview.status === "loading") {
    body = <LoadingState label="Preparing the change…" />;
  } else if (preview.status === "error") {
    body = (
      <ErrorState
        title={preview.conflict ? "The file changed on disk" : preview.notEditable ? "Portplane can't rewrite this part" : "Couldn't prepare the change"}
        message={preview.notEditable ? `${preview.message}. Edit it as text in the YAML tab, or in your editor.` : preview.message}
        onRetry={preview.conflict ? undefined : load}
      />
    );
  } else {
    const v = preview.value;
    body = (
      <div className="review-step">
        {changed.length === 0 ? (
          <p className="muted">Nothing changes in the file.</p>
        ) : (
          <>
            <p className="review-lead">Only these lines change.</p>
            {changed.map((f) => (
              <FileDiff key={f.path} file={f} folder={folder} />
            ))}
          </>
        )}
        {v.problems.length > 0 && (
          <div className="review-problems" role="alert">
            <p className="review-problems-title">
              <Icon name="warning" size={14} /> dekit would refuse this config:
            </p>
            <ul>
              {v.problems.map((p, i) => (
                <li key={i}>
                  {p.line ? <span className="mono">line {p.line}: </span> : null}
                  {p.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.warnings.length > 0 && (
          <ul className="review-warnings">
            {v.warnings.map((w) => (
              <li key={w}>
                <Icon name="info" size={13} /> {w}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={saved ? "Apply to the running project" : title}
      size="md"
      dismissable={!saving}
      footer={
        saved ? undefined : (
          <>
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={blocked || saving} aria-busy={saving || undefined} onClick={() => void save()}>
              {saving && <Spinner />}
              Save
            </button>
          </>
        )
      }
    >
      {body}
    </Dialog>
  );
}
