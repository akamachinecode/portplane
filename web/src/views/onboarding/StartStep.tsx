import { useEffect, useMemo, useState } from "react";
import { errorText } from "../../api/errors";
import type { App, Excerpt } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { useMachineScope } from "../../components/MachineScope";
import { appHref } from "../../lib/apps";
import { EmptyState } from "../../components/States";
import { inferHome, shortenPath } from "../../lib/format";
import { appRoute, href } from "../../lib/router";
import { useOnboarding } from "./context";
import { Mark, NextButton, StepFooter, StepLayout } from "./parts";
import { count, firstWorking, sentence, preselect, startCandidates, startPhase, startTargets } from "./summary";

function FailedApp({ app }: { app: App }) {
  const { api } = useApp();
  const { id: machine } = useMachineScope();
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.excerpt(machine, app.runner, app.task).then(setExcerpt, (err: unknown) => setError(errorText(err)));
  }, [api, machine, app.runner, app.task]);
  return (
    <div className="ob-failed">
      {excerpt && excerpt.lines.length > 0 && (
        <pre className="ob-excerpt mono" tabIndex={0} aria-label={`Last lines of ${app.label}`}>
          {excerpt.lines.join("\n")}
        </pre>
      )}
      {error && <p className="muted">Couldn't read its output: {error}</p>}
      <div className="ob-tool-actions">
        <a className="btn btn-sm" href={href(appRoute(machine, app.id))}>
          Why
        </a>
        <a className="btn btn-sm btn-ghost" href={href(appRoute(machine, app.id, "output"))}>
          See the output
        </a>
      </div>
    </div>
  );
}

/** Step 8: start a few apps and see the first one load. */
export function StartStep() {
  const { api, toast } = useApp();
  const { id: machine, ms } = useMachineScope();
  const { roots, folders } = useOnboarding();
  const runners = roots.length ? roots : folders;
  const apps = useMemo(() => startCandidates(ms ?? undefined, runners), [ms, runners]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = inferHome(runners);

  // Tick the main app of each project once the apps are known.
  useEffect(() => {
    if (picked === null && apps.length) setPicked(preselect(apps));
  }, [apps, picked]);
  const chosen = picked ?? new Set<string>();

  const start = async () => {
    if (!ms) return;
    setStarting(true);
    setError(null);
    try {
      for (const t of startTargets(machine, apps, chosen)) {
        if (!ms.runners.find((r) => r.root === t.runner)?.up) await api.runnerUp(machine, t.runner);
        await api.act(t, "start");
      }
      setStarted(new Set(chosen));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const first = firstWorking(apps, started);
  const phases = apps.filter((a) => started.has(a.id)).map(startPhase);
  const waiting = phases.filter((p) => p === "waiting" || p === "starting").length;
  const failed = phases.filter((p) => p === "failed").length;
  const open = (url: string) => void api.open(machine, [url]).catch((err: unknown) => toast.error(errorText(err)));
  // A remote app opens through Portplane's tunnel (ADR-0016).
  const urlOf = (a: App) => (ms ? appHref(a, ms.machine) : a.url);

  let status = "";
  if (starting) status = "Starting…";
  else if (started.size && waiting) status = sentence(`${count(waiting, "app")} still starting…`);
  else if (started.size && failed) status = sentence(`${count(failed, "app")} didn't start.`);
  else if (started.size) status = "Everything you picked is running.";
  else if (chosen.size) status = sentence(`${count(chosen.size, "app")} picked.`);

  return (
    <StepLayout
      icon="play"
      title="Start something now?"
      lead="Pick a few apps to start. Portplane starts dekit for their project, then each app, and shows you when its address works."
      busy={starting}
      footer={
        <StepFooter status={status}>
          {started.size === 0 ? (
            <>
              <NextButton label="Not now" primary={false} />
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={starting || chosen.size === 0} aria-busy={starting || undefined}>
                {starting ? <Spinner size={12} /> : <Icon name="play" size={14} />}
                Start {chosen.size ? count(chosen.size, "app") : "apps"}
              </button>
            </>
          ) : (
            <NextButton label="Finish" />
          )}
        </StepFooter>
      }
    >
      {apps.length === 0 ? (
        <EmptyState icon="apps" title="No apps to start yet">
          {ms ? "Nothing was set up on the previous steps. You can start apps any time from the Apps view." : "Waiting for Portplane to read your apps…"}
        </EmptyState>
      ) : (
        <>
          {first && urlOf(first) && (
            <div className="ob-celebrate" role="status">
              <span className="ob-celebrate-icon" aria-hidden="true">
                <Icon name="checkCircle" size={22} />
              </span>
              <div>
                <p className="ob-celebrate-title">Your first app is running</p>
                <p className="ob-celebrate-url mono">{urlOf(first)}</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => open(urlOf(first)!)}>
                <Icon name="open" size={14} />
                Open it
              </button>
            </div>
          )}
          {error && (
            <p className="field-error" role="alert">
              Couldn't start them: {error}
            </p>
          )}
          <ul className="ob-start-list" aria-label="Apps">
            {apps.map((a) => {
              const was = started.has(a.id);
              const phase = startPhase(a);
              const tone = !was ? null : phase === "on" ? "ok" : phase === "failed" ? "bad" : "busy";
              return (
                <li key={a.id} className={`ob-start${was ? ` is-${phase}` : ""}`}>
                  <label className="ob-start-pick">
                    <input
                      type="checkbox"
                      checked={chosen.has(a.id)}
                      disabled={started.size > 0}
                      onChange={(e) => {
                        const n = new Set(chosen);
                        if (e.target.checked) n.add(a.id);
                        else n.delete(a.id);
                        setPicked(n);
                      }}
                    />
                    {tone && <Mark tone={tone} label={phase} />}
                    <span className="ob-start-name">{a.label}</span>
                    <span className="ob-start-meta muted">
                      {[a.project, a.worktree].filter(Boolean).join(" · ")}
                      {a.hostname && <span className="mono"> · {a.hostname}</span>}
                    </span>
                  </label>
                  <span className="ob-start-state">
                    {was && phase === "starting" && "Starting…"}
                    {was && phase === "waiting" && "Waiting…"}
                    {was && phase === "failed" && "Didn't start"}
                    {phase === "on" && urlOf(a) && (
                      <button type="button" className="btn btn-sm" onClick={() => open(urlOf(a)!)}>
                        <Icon name="open" size={13} />
                        Open
                      </button>
                    )}
                  </span>
                  {was && phase === "failed" && <FailedApp app={a} />}
                </li>
              );
            })}
          </ul>
          <p className="muted ob-note">
            Apps from {runners.map((r) => shortenPath(r, home)).join(", ")}. The ones you don't start now are one click away in the Apps view.
          </p>
        </>
      )}
    </StepLayout>
  );
}
